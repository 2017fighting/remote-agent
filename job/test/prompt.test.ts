import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROMPT_TEMPLATE_KEYS,
  readPromptFile,
  renderReviewPrompt,
  resolvePromptTemplates,
  type PromptSources,
  type PromptTemplates,
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

describe("prompt resolution (ADR-0020)", () => {  it("logs prompt-source=<key>:image for every key when only the image carries them", async () => {
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
   * The override hatch's acceptance case (#77): an operator creates the override
   * directory with only `_common`, and every other key still comes from the image.
   * `_common` is the one key every role reads, so this is the shape a real
   * incident edit takes.
   */
  it("uses `_common` from the override and every other key from the image", async () => {
    await writeAll(image, (key) => `image:${key}`);
    await writeKey(override, "_common", "hot-edited common");
    const log: string[] = [];

    const templates = await resolvePromptTemplates(sources(log, override));

    expect(templates["_common"]).toBe("hot-edited common");
    expect(log).toContain("prompt-source=_common:override");
    for (const key of KEYS.filter((key) => key !== "_common")) {
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

describe("review prompt rendering", () => {
  const templates = (overrides: Partial<Record<string, string>> = {}): PromptTemplates => {
    const base = {
      "_common": "common",
      "implement-ticket": "ticket",
      "implement-spec": "spec",
      "review-spec": "spec {{fixed_point}} {{spec_ref}} {{spec_body}}",
      "review-standards": "standards {{fixed_point}} files:\n{{standards_files}}",
    };
    return { ...base, ...overrides } as PromptTemplates;
  };

  /**
   * The standards list reaches the reviewer through the same substitution as the
   * other inputs, so the template's closing instructions stay last. The empty scan
   * says so in words: a blank section would leave the reviewer guessing.
   */
  it("substitutes the scanned standards files, and names an empty scan", () => {
    const rendered = renderReviewPrompt({
      axis: "standards",
      fixedPoint: "abc123",
      specRef: "o/r#1",
      specBody: "",
      standardsFiles: ["CODING_STANDARDS.md", "docs/CONTRIBUTING.md"],
      templates: templates(),
    });
    expect(rendered).toContain("- `CODING_STANDARDS.md`");
    expect(rendered).toContain("- `docs/CONTRIBUTING.md`");

    const empty = renderReviewPrompt({
      axis: "standards",
      fixedPoint: "abc123",
      specRef: "o/r#1",
      specBody: "",
      templates: templates(),
    });
    expect(empty).toContain("no written standards files");
    expect(empty).not.toContain("{{standards_files}}");
  });

  it("leaves the Spec axis untouched by the standards list", () => {
    const rendered = renderReviewPrompt({
      axis: "spec",
      fixedPoint: "abc123",
      specRef: "o/r#7",
      specBody: "THE SPEC",
      standardsFiles: ["AGENTS.md"],
      templates: templates(),
    });
    expect(rendered).toBe("spec abc123 o/r#7 THE SPEC");
  });
});
