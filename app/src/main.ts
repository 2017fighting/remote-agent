import { readAppConfig } from "./config.js";
import { createScheduler, formatPassLog, formatVolumeStatsLog } from "./scheduler.js";
import { createWebhookServer } from "./server.js";
import { runReconcilePass } from "./reconcile.js";
import { OctokitGitHub } from "./adapters/octokit.js";
import { KubeClientK8s } from "./adapters/k8s.js";
import type { AppConfig } from "./config.js";

/**
 * App entry point: read env once, wire ports → scheduler → webhook server.
 * Production adapters are stubs until later tickets; the wiring here is the
 * final shape the adapters will slot into.
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

  // Production adapters (behind ports). Stubs until their tickets land; the
  // App never talks to octokit or the k8s client directly.
  const github = options?.github ?? new OctokitGitHub({
    appId: config.githubAppId,
    clientId: env["GITHUB_APP_CLIENT_ID"] ?? "",
    privateKey: env["GITHUB_APP_PRIVATE_KEY"] ?? "",
    apiBaseUrl: config.githubApiBaseUrl,
  });
  const k8s = options?.k8s ?? new KubeClientK8s({ namespace: env["NAMESPACE"] ?? "remote-agent" });

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
  const server = createWebhookServer({ webhookSecret, wake: (t) => scheduler.wake(t) });
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
