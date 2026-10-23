import { createModels, createProvider, envApiKeyAuth, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { JOB_ENV_KEYS } from "@remote-agent/shared";

/**
 * OmniRoute wiring (docs/deployment.md §9). Two real combos, metadata taken from
 * the live `/v1/models`: 1M context on both, `maxTokens` 131072 for the runner and
 * 65536 for the reviewer. No `compat` and no `thinkingLevelMap`: the automatic
 * compat is accepted by OmniRoute and `high` needs no mapping.
 */
export const OMNIROUTE_PROVIDER_ID = "omniroute";

export interface OmniRouteConfig {
  baseUrl: string;
  model: string;
  reviewModel: string;
}

export function omniRouteModels(config: OmniRouteConfig): [Model<"openai-completions">, Model<"openai-completions">] {
  const base = {
    api: "openai-completions" as const,
    provider: OMNIROUTE_PROVIDER_ID,
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
  };
  return [
    { ...base, id: config.model, name: config.model, maxTokens: 131_072 },
    { ...base, id: config.reviewModel, name: config.reviewModel, maxTokens: 65_536 },
  ];
}

/**
 * The runner's model catalog. The key is resolved by pi-ai from
 * `OMNIROUTE_API_KEY` on every request, so nothing here reads or copies the
 * secret; a missing key is caught at startup by the env validation instead.
 */
export function createOmniRouteModels(config: OmniRouteConfig): Models {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: OMNIROUTE_PROVIDER_ID,
      name: "OmniRoute",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("OmniRoute API key", [JOB_ENV_KEYS.omniRouteApiKey]) },
      api: openAICompletionsApi(),
      models: omniRouteModels(config),
    }),
  );
  return models;
}

export function modelRef(config: OmniRouteConfig): { provider: string; modelId: string } {
  return { provider: OMNIROUTE_PROVIDER_ID, modelId: config.model };
}

export function reviewModelRef(config: OmniRouteConfig): { provider: string; modelId: string } {
  return { provider: OMNIROUTE_PROVIDER_ID, modelId: config.reviewModel };
}
