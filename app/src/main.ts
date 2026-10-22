import { APP_ENV_KEYS } from "@remote-agent/shared";
import { readAppConfig } from "./config.js";
import { createScheduler, formatPassLog, formatVolumeStatsLog } from "./scheduler.js";
import { createWebhookServer } from "./server.js";
import { runReconcilePass } from "./reconcile.js";
import { OctokitGitHub } from "./adapters/octokit.js";
import { KubeClientK8s } from "./adapters/k8s.js";
import type { AppConfig } from "./config.js";

/**
 * App entry point: read env once, wire ports → scheduler → webhook server.
 */
export async function startApp(options?: {
  env?: Record<string, string | undefined>;
  github?: Parameters<typeof runReconcilePass>[0]["github"];
  k8s?: Parameters<typeof runReconcilePass>[0]["k8s"];
  log?: (line: string) => void;
  webhookSecret?: string;
  port?: number;
}): Promise<{ stop: () => Promise<void> }> {
  const env = options?.env ?? process.env;
  const log = options?.log ?? ((line: string) => console.log(line));
  const config: AppConfig = readAppConfig(env);

  // Production adapters (behind ports); the App never talks to octokit or the
  // k8s client directly.
  const github = options?.github ?? new OctokitGitHub({
    appId: config.githubAppId,
    privateKey: env[APP_ENV_KEYS.githubAppPrivateKey] ?? "",
    apiBaseUrl: config.githubApiBaseUrl,
  });
  const k8s = options?.k8s ?? new KubeClientK8s({ namespace: config.namespace });

  const scheduler = createScheduler(config, {
    reconcile: (trigger) => runReconcilePass({ github, k8s, config }, trigger),
    listIssues: () => github.listIssues(),
    onPassLog: (line) => {
      log(formatPassLog(line));
      // Second line of every pass: the App's own volume usage (ADR-0011).
      log(formatVolumeStatsLog(line.volumeStats));
    },
    onPassError: (trigger, error) =>
      log(`pass-error trigger=${trigger} error=${error instanceof Error ? error.message : String(error)}`),
  });

  const webhookSecret = options?.webhookSecret ?? env["GITHUB_WEBHOOK_SECRET"] ?? "";
  // The image declares PORT=8080 (app/Dockerfile) and the Deployment's Service
  // targets that port, so the App must bind it — on all interfaces, because a
  // loopback listener is unreachable from the Service and from the kubelet's
  // readiness probe. Unset (unit tests, `node` on a laptop) keeps the ephemeral
  // loopback default.
  const port = options?.port ?? readPort(env["PORT"]);
  const server = createWebhookServer({
    webhookSecret,
    wake: (t) => scheduler.wake(t),
    ...(port === undefined ? {} : { host: "0.0.0.0", port }),
  });
  await server.ready();
  log(`webhook listening on ${server.host}:${server.port}/webhook`);

  // Startup: one list + one trigger=startup pass (ADR-0014), then the tick arms.
  await scheduler.start();

  return {
    stop: async () => {
      scheduler.stop();
      await server.close();
    },
  };
}

/** `PORT` from the image env; absent or unusable means "let the OS choose". */
function readPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT=${raw} is not a valid TCP port`);
  }
  return port;
}
