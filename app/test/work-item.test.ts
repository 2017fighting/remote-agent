import { describe, expect, it } from "vitest";
import {
  OMITTED_COMMENTS_PLACEHOLDER,
  WORK_ITEM_MAX_BYTES,
  renderWorkItem,
  serializeWorkItem,
  type WorkItem,
} from "../src/renders/work-item.js";
import type { GitHubComment } from "../src/ports/GitHubPort.js";
import { GATE_LABELS, REPO, issue } from "./world.js";

/**
 * AGENT_WORK_ITEM (spec #33 §0): repo, issue number, spec number, title, body
 * and comments in chronological order, as JSON, inside a 512 KB budget. The
 * body is always kept verbatim; comments are dropped oldest-first and replaced
 * by one pointer line.
 */

function comment(id: number, body: string, createdAt: string): GitHubComment {
  return { id, ownerRepo: REPO, issueNumber: 35, body, createdAt };
}

function render(comments: GitHubComment[] = []): WorkItem {
  return renderWorkItem({
    issue: issue(35, GATE_LABELS, { title: "Claim a ticket", body: "## What to build\n\nclaim it" }),
    specNumber: 33,
    comments,
  });
}

describe("work item content", () => {
  it("carries repo, issue number, spec number, title and the body verbatim", () => {
    const item = render();
    expect(item.repo).toBe(REPO);
    expect(item.issueNumber).toBe(35);
    expect(item.specNumber).toBe(33);
    expect(item.title).toBe("Claim a ticket");
    expect(item.body).toBe("## What to build\n\nclaim it");
    expect(item.comments).toEqual([]);
  });

  it("keeps comments in chronological order", () => {
    const item = render([
      comment(1, "first", "2025-01-01T00:00:00Z"),
      comment(2, "second", "2025-01-02T00:00:00Z"),
      comment(3, "third", "2025-01-03T00:00:00Z"),
    ]);
    expect(item.comments.map((c) => c.body)).toEqual(["first", "second", "third"]);
  });

  it("includes the newTickets context when a closeout produced one", () => {
    const item = renderWorkItem({
      issue: issue(35, GATE_LABELS),
      specNumber: 33,
      comments: [],
      newTicketsContext: "Sub-issues created by the last closeout run: #40, #41",
    });
    expect(item.newTicketsContext).toBe("Sub-issues created by the last closeout run: #40, #41");
    expect(render().newTicketsContext).toBeUndefined();
  });

  it("serializes to JSON that round-trips", () => {
    const json = serializeWorkItem(render([comment(1, "hi", "2025-01-01T00:00:00Z")]));
    expect(JSON.parse(json)).toMatchObject({
      repo: REPO,
      issueNumber: 35,
      specNumber: 33,
      title: "Claim a ticket",
      comments: [{ createdAt: "2025-01-01T00:00:00Z", body: "hi" }],
    });
  });
});

describe("work item budget (512 KB)", () => {
  it("keeps everything when the item fits", () => {
    const json = serializeWorkItem(render([comment(1, "small", "2025-01-01T00:00:00Z")]));
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(WORK_ITEM_MAX_BYTES);
    expect(JSON.parse(json).omittedComments).toBeUndefined();
    expect(JSON.parse(json).comments).toHaveLength(1);
  });

  it("drops comments oldest-first, keeping a suffix of the newest ones", () => {
    const big = "x".repeat(200 * 1024);
    const comments = ["oldest", "second", "third", "latest"].map((label, i) =>
      comment(i + 1, `${label} ${big}`, `2025-01-0${i + 1}T00:00:00Z`),
    );
    const json = serializeWorkItem(render(comments));
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(WORK_ITEM_MAX_BYTES);

    const parsed = JSON.parse(json) as WorkItem;
    expect(parsed.omittedComments).toBe(OMITTED_COMMENTS_PLACEHOLDER);
    const kept = parsed.comments.map((c) => c.body.split(" ")[0]);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4);
    // A suffix: the newest comment always survives, the oldest never does.
    expect(kept[kept.length - 1]).toBe("latest");
    expect(kept).not.toContain("oldest");
    expect(kept).toEqual(["oldest", "second", "third", "latest"].slice(4 - kept.length));
  });

  it("drops the newest comment too when nothing fits, keeping only the pointer line", () => {
    const big = "x".repeat(600 * 1024);
    const json = serializeWorkItem(
      render([comment(1, `only ${big}`, "2025-01-01T00:00:00Z"), comment(2, `second ${big}`, "2025-01-02T00:00:00Z")]),
    );
    const parsed = JSON.parse(json) as WorkItem;
    expect(parsed.comments).toEqual([]);
    expect(parsed.omittedComments).toBe(OMITTED_COMMENTS_PLACEHOLDER);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(WORK_ITEM_MAX_BYTES);
  });

  it("keeps the body verbatim even when comments must all go", () => {
    const body = "b".repeat(300 * 1024);
    const comments = Array.from({ length: 5 }, (_, i) =>
      comment(i + 1, "c".repeat(400 * 1024), `2025-01-0${i + 1}T00:00:00Z`),
    );
    const json = serializeWorkItem(
      renderWorkItem({ issue: issue(35, GATE_LABELS, { body }), specNumber: 33, comments }),
    );
    const parsed = JSON.parse(json) as WorkItem;
    expect(parsed.body).toBe(body);
    expect(parsed.comments).toEqual([]);
    expect(parsed.omittedComments).toBe(OMITTED_COMMENTS_PLACEHOLDER);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(WORK_ITEM_MAX_BYTES);
  });

  it("keeps the body verbatim even when the body alone exceeds the budget", () => {
    const body = "b".repeat(WORK_ITEM_MAX_BYTES + 1024);
    const json = serializeWorkItem(
      renderWorkItem({ issue: issue(35, GATE_LABELS, { body }), specNumber: 33, comments: [] }),
    );
    expect((JSON.parse(json) as WorkItem).body).toBe(body);
  });
});
