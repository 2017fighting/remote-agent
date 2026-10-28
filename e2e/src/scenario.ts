import type { Scenario } from "../stub-github/state.js";
import type { ModelScript } from "../stub-model/script.js";

/**
 * The spec-complete scenario (spec #33 Testing Decisions 3, ticket #41): one
 * spec, two tickets in sequence, then the closeout.
 *
 * Shape of the world the harness starts from:
 *
 *   #33 (spec)  ready-for-agent + agent:implement        ← the one authorization
 *    ├─ #34 (ticket) ready-for-agent                    ← Frontier first
 *    └─ #35 (ticket) ready-for-agent                    ← Frontier second
 *
 * The tickets deliberately carry **no** `agent:implement` (ticket #46): the
 * spec's authorization is what makes them claimable, so this scenario proves the
 * inheritance end to end — a human authorizes the spec once and never touches a
 * ticket. It also pins the second half of the rule: Claim must not copy the
 * label down, so `agent:implement` never appears on #34 / #35 in the final world
 * unless a human wrote it there.
 *
 * Claim order is the spec loop's, not the harness's: each pass computes one
 * Frontier per spec and claims it, so #34 is claimed before #35 without the
 * harness adding a label between them. The runs are not serialized, though —
 * once #34 carries `agent:in-progress` it leaves the Frontier while #35 still
 * passes the Claim-gate, so both Jobs end up running at the same time.
 *
 * The end state the scenario asserts: both tickets closed, the spec
 * `ready-for-human`, a ready PR on `agent/spec-33` whose body carries
 * `Closes #33`, and `expires-at` on both Ticket PVCs.
 */

export const TARGET_REPO = "2017fighting/remote-agent";
export const SPEC_NUMBER = 33;
export const TICKET_NUMBERS = [34, 35] as const;

export const SCENARIO: Scenario = {
  repo: TARGET_REPO,
  issues: [
    {
      number: SPEC_NUMBER,
      title: "Spec: remote-agent v1",
      body: [
        "## Problem Statement",
        "The e2e scenario's spec body. It exists so the ticket work items carry a",
        "real parent body (the Spec axis of the reviewer reads it).",
        "",
        "## Solution",
        "Two tickets, then a closeout that opens one PR.",
      ].join("\n"),
      state: "open",
      labels: ["ready-for-agent", "agent:implement"],
    },
    {
      number: 34,
      title: "Ticket one: the first half",
      body: [
        "## Acceptance criteria",
        "- [ ] the first half exists",
        "",
        "## Seams",
        "One seam, stated in the ticket so the agent does not have to infer it.",
      ].join("\n"),
      state: "open",
      // No `agent:implement`: inherited from spec #33 (ticket #46).
      labels: ["ready-for-agent"],
    },
    {
      number: 35,
      title: "Ticket two: the second half",
      body: ["## Acceptance criteria", "- [ ] the second half exists"].join("\n"),
      state: "open",
      labels: ["ready-for-agent"],
    },
  ],
  subIssues: { [SPEC_NUMBER]: [34, 35] },
  blockers: {},
  comments: [],
  pullRequests: [],
};

/**
 * The scripted model turns.
 *
 * Two conversations run per Job: the runner (`default`) and, once it calls
 * `code_review`, the reviewer (`review`). Both tickets follow the same shape —
 * read the work item, write a file, commit, review, finish — so the script is
 * written as a repeating pattern and the only thing that differs per ticket is
 * which file it writes.
 *
 * `finish_ticket` is what fixes the outcome: the verdict is the fixture's, not a
 * model's (spec #33 Testing Decisions 3). The reviewer's answers are text, since
 * the reviewer has no Result tools.
 *
 * NOTE for whoever runs this against #43's adapters: the exact tool names here
 * are the runner's own tool table (read/write/edit/bash + finish_ticket +
 * blocked + code_review, per job/test/result-tools.test.ts), so a script step
 * naming a tool the runner does not offer fails loudly instead of being ignored.
 */

/** One ticket's turns: read, write, commit, review, finish. */
function ticketTurns(ticketNumber: number, fileName: string): ModelScript["steps"] {
  return [
    {
      model: "default",
      toolCalls: [{ name: "read", arguments: { path: "README.md" }, id: `read-${ticketNumber}` }],
    },
    {
      model: "default",
      toolCalls: [
        {
          name: "write",
          arguments: { path: fileName, content: `# ${fileName}\n\nWritten by the ticket ${ticketNumber} run.\n` },
          id: `write-${ticketNumber}`,
        },
      ],
    },
    {
      model: "default",
      toolCalls: [
        {
          name: "bash",
          arguments: { command: `git add -A && git commit -m "ticket ${ticketNumber}: add ${fileName} (#${ticketNumber})"` },
          id: `commit-${ticketNumber}`,
        },
      ],
    },
    {
      model: "default",
      toolCalls: [{ name: "code_review", arguments: { fixedPoint: "HEAD" }, id: `review-${ticketNumber}` }],
    },
    // The reviewer conversation's two axes, in the order `code_review` runs them.
    { model: "review", text: "Standards axis: the diff follows the repository's conventions. No findings." },
    { model: "review", text: "Spec axis: the change matches the ticket's acceptance criteria. No findings." },
    {
      model: "default",
      toolCalls: [
        {
          name: "finish_ticket",
          arguments: {
            summary: `Ticket ${ticketNumber}: added ${fileName} and committed it.`,
            commentBody: `Added \`${fileName}\` and committed it with the ticket number.`,
            warnings: [],
          },
          id: `finish-${ticketNumber}`,
        },
      ],
    },
  ];
}

export const MODEL_SCRIPT: ModelScript = {
  steps: [
    ...ticketTurns(34, "ticket-one.md"),
    ...ticketTurns(35, "ticket-two.md"),
    // The closeout run (`implement-spec`): review the whole branch, then finish.
    {
      model: "default",
      toolCalls: [{ name: "bash", arguments: { command: "git log --oneline origin/main..HEAD" }, id: "closeout-log" }],
    },
    {
      model: "default",
      toolCalls: [{ name: "code_review", arguments: { fixedPoint: "origin/main" }, id: "closeout-review" }],
    },
    { model: "review", text: "Standards axis: the whole branch follows the repository's conventions." },
    { model: "review", text: "Spec axis: every acceptance criterion in the spec is covered." },
    {
      model: "default",
      toolCalls: [
        {
          name: "finish_spec",
          arguments: {
            summary: "Both tickets landed; the branch is ready to merge.",
            prBody: [
              "## What changed",
              "",
              "- Ticket one: `ticket-one.md`",
              "- Ticket two: `ticket-two.md`",
              "",
              "## Verification",
              "",
              "Both tickets' runs completed and pushed to this branch.",
            ].join("\n"),
            commentBody: "Both tickets are closed and the branch is ready for review.",
            newTickets: [],
            warnings: [],
          },
          id: "finish-spec",
        },
      ],
    },
  ],
};

/** The webhook deliveries the harness sends, in order. */
export const WEBHOOK_DELIVERIES = [
  { event: "issues", action: "labeled" },
  { event: "issues", action: "labeled" },
] as const;
