import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROMPT_TEMPLATE_KEYS,
  readPromptFile,
  resolvePromptTemplates,
  type PromptSources,
} from "../src/internal/prompt.js";

const KEYS = [...PROMPT_TEMPLATE_KEYS];

let root: string;
let image: string;
let override: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "remote-agent-prompts-"));
  image = join(root, "image");
  override = join(root, "override");
  await mkdir(image, { recursive: true });
  await mkdir(override, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeKey(dir: string, key: string, text: string): Promise<void> {
  await writeFile(join(dir, key), text);
}

async function writeAll(dir: string, text: (key: string) => string): Promise<void> {
  for (const key of KEYS) await writeKey(dir, key, text(key));
}

function sources(log: string[], overrideDir?: string): PromptSources {
  return { imageDir: image, ...(overrideDir === undefined ? {} : { overrideDir }), log: (line) => log.push(line) };
}

describe("prompt resolution (ADR-0020)", () => {
  it("logs prompt-source=<key>:image for every key when only the image carries them", async () => {
    await writeAll(image, (key) => `image:${key}`);
    const log: string[] = [];

    const templates = await resolvePromptTemplates(sources(log, override));

    for (const key of KEYS) {
      expect(templates[key]).toBe(`image:${key}`);
      expect(log).toContain(`prompt-source=${key}:image`);
    }
    // One line per key, and no `:override` line anywhere.
    expect(log).toHaveLength(KEYS.length);
    expect(log.some((line) => line.endsWith(":override"))).toBe(false);
  });

  it("reads a key from the override directory and leaves the rest on the image", async () => {
    await writeAll(image, (key) => `image:${key}`);
    await writeKey(override, "implement-ticket", "hot-edited ticket template");
    const log: string[] = [];

    const templates = await resolvePromptTemplates(sources(log, override));

    expect(templates["implement-ticket"]).toBe("hot-edited ticket template");
    expect(log).toContain("prompt-source=implement-ticket:override");
    for (const key of KEYS.filter((key) => key !== "implement-ticket")) {
      expect(templates[key]).toBe(`image:${key}`);
      expect(log).toContain(`prompt-source=${key}:image`);
    }
  });

  /**
   * The review-axis templates and the role templates go through the same
   * `readPromptFile` fallback: overriding a review key behaves exactly like
   * overriding a role key, and there is no second rule to drift.
   */
  it("routes the review-axis keys through the same fallback as the role keys", async () => {
    await writeAll(image, (key) => `image:${key}`);
    await writeKey(override, "review-spec", "hot-edited spec axis");
    const log: string[] = [];

    const templates = await resolvePromptTemplates(sources(log, override));

    expect(templates["review-spec"]).toBe("hot-edited spec axis");
    expect(log).toContain("prompt-source=review-spec:override");
    expect(templates["review-standards"]).toBe("image:review-standards");
    expect(log).toContain("prompt-source=review-standards:image");
  });

  it("throws naming both directories when neither carries a key", async () => {
    await writeAll(image, (key) => `image:${key}`);
    await rm(join(image, "review-standards"));

    await expect(resolvePromptTemplates(sources([], override))).rejects.toThrow(
      new RegExp(`review-standards.*override directory \\(${override}\\).*image directory \\(${image}\\)`),
    );
  });

  it("treats a missing override directory as no override, not an error", async () => {
    await writeAll(image, (key) => `image:${key}`);

    await expect(readPromptFile(sources([], join(root, "does-not-exist")), "_common")).resolves.toBe("image:_common");
  });
});
