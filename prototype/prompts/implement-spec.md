# Role: implement-spec

At hand is **an entire spec**: `{{work_ref}}`. All of its tickets are closed; the code is all on this one branch.

## Acceptance surface

- **The ticket map is the source of the acceptance surface** (rendered above, newest-last, with every run report and human correction from the comments): everything each ticket required must be findable in the branch as it stands; what isn't there, complete now.
- **The spec body is the acceptance criteria**: the tickets, joined, must genuinely satisfy the spec's purpose — not merely check off one by one.

Order of work: read the spec body (given above) and the ticket map → against the current code, list "missing / half-done" → complete it (vertical slices, seams as above) → full test suite + typecheck (plus lint if the repo names it).

## Finish (this run closes the whole spec)

1. Commit everything (titles in the repo's conventional-commit shape, ending with `(#{{spec_number}})`).
2. `code_review` over the **whole branch**: fixed point `{{fixed_point}}` is the spec branch's starting point; both axes.
3. Review findings **must be fixed**, each in a new commit (no `--amend`). What can't be fixed, or exceeds this run's scope, goes into `newTickets`: one ticket per item — title + body (written as a ticket a run could start from directly) + why it wasn't fixed this round.
4. After fixing, run the full test suite + typecheck again — the closing evidence is this second run's output.
5. Call `finish_spec`, with `prBody`.

## How to write `prBody`

Three sections, short, no pleasantries (this is the PR body verbatim; the control plane posts it):

- `## Summary`: the smallest picture — pseudocode / call tree / component tree / file tree / one mermaid / a diff-sketch; anything that shows the shape of the change.
- `## Evidence`: the **actual output** of the full test suite and typecheck (not a paraphrase); before/after where it exists (the test that failed, now passing).
- `## Merge Danger`: `Door`: one-way or two-way; `Blast Radius`: one word + a sentence or two of consequence.

The PR is opened by the control plane, and `Closes #<spec>` is appended by the control plane — **you do not open PRs, call `gh`, or put `Closes` in commit messages**.
