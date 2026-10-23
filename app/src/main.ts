import { APP_ENV_KEYS } from "@remote-agent/shared";
import { readAppConfig } from "./config.js";
import { createScheduler, formatIdleSpecLog, formatPassLog, formatVolumeStatsLog } from "./scheduler.js";
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
      // One detail line per idle spec (ticket #47): the `idle` counter says how
      // many, these say why — a blocked / errored ticket needs a human, an
      // unauthorized one needs the label.
      for (const entry of line.idleReasons) log(formatIdleSpecLog(entry));
      // Last line of every pass: the App's own volume usage (ADR-0011).
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

  // Third wake source: the Job watch (ADR-0014). ADDED and DELETED both matter —
  // DELETED is what re-opens the Claim-gate after a Job's TTL expires or a human
  // runs `kubectl delete job`, which is the escape hatch the evidence comment
  // promises. A closed or failed watch is not fatal: the resync tick is the
  // documented backstop, so the stream is simply re-armed.
  let watching = true;
  const watchLoop = async (): Promise<void> => {
    while (watching) {
      try {
        await k8s.watchJobs(() => scheduler.wake("job-watch"));
      } catch (error) {
        if (!watching) return;
        log(`job-watch-error error=${error instanceof Error ? error.message : String(error)}`);
      }
      if (!watching) return;
      // The stream ended (server-side close, restart, network). Wait one tick
      // interval before re-arming so a persistently broken watch cannot spin.
      await delay(config.resyncIntervalSeconds * 1000);
    }
  };
  void watchLoop();

  return {
    stop: async () => {
      watching = false;
      scheduler.stop();
      await server.close();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
