# Your first literary change

This tutorial uses local files only. The four [complete examples](../examples/README.md) contain the resulting artifacts in English and Portuguese.

1. Install from the repository and start a project: `npm install -g git+https://github.com/elaranjo/StorySpec.git`, then `mkdir my-story && cd my-story && storyspec init "My story" --profile novel`.
2. Create the plan: `storyspec new chapter opening`, `storyspec new scene opening choice`, and `storyspec new delta opening plot`. Fill `proposal.md`, `design.md`, `chapter-contract.md`, and `scenes/choice.md` under `storyspec/changes/opening/`. Keep their generated headings, replace placeholders, and cite a real project path in each required Sources list. Fill the delta with an `ADDED` requirement. The [English Novel example](../examples/novel-en/) shows every file.
3. Run `storyspec next opening`, `storyspec validate opening`, then `storyspec approve opening plan --author "Your name"`. Plan approval binds the files and sources used for the decision.
4. Write `manuscript/opening.md` in your editor and accept it with `storyspec manuscript accept opening manuscript/opening.md --author "Your name"`. The CLI records its hash and does not edit the prose.
5. Describe the scene: `storyspec map scene set opening choice --order 1 --origin "The story begins"`. For a requirement named `plot/costly-choice`, run `storyspec map coverage set opening plot/costly-choice --status realized` and `storyspec map passage add opening plot/costly-choice --scene choice --lines 3:3`. The passage command reads the accepted path and hash. Use `partial --target <future-chapter> --reason <why>` for incomplete coverage, or `deferred` with the same explanation when no manuscript realizes the requirement.
6. Run `storyspec verify opening --json`. Correct file and hash errors. To justify a waivable narrative finding, use `storyspec map waive opening <issue-id> --author "Your name" --reason "Why"`. Then run `storyspec verify opening --record`.
7. Check the boxes in `tasks.md`. Generate `storyspec review opening dramaturgy`, edit its JSON report, and record it with `storyspec review opening dramaturgy --record --author "Reviewer"`. Repeat for `continuity` and `prose`. The dramaturgy report needs a `requirementAssessments` entry for every realized or partial requirement: `{"domain":"plot","requirement":"costly-choice","verdict":"SATISFIED","rationale":"The cited choice has a visible consequence."}`. A person must make this judgment.
8. Run `storyspec approve opening final --author "Your name"`, `storyspec apply opening --dry-run`, `storyspec apply opening`, and `storyspec archive opening`. Inspect the result with `storyspec history opening`.

Run `storyspec status opening --json` at any point for artifacts and blockers. Run `storyspec reconcile opening --json` after changing a plan, source, review, accepted manuscript, or parallel story state. Approvals that become stale must be recorded again by their responsible person.

## Optional assistant instructions

`storyspec adapters install codex --dry-run` previews one project-local integration. Replace `codex` with `claude` or `cursor`; omit `--dry-run` to install. Each adapter uses the same [assistant contract](assistant-contract.md). The CLI and human decisions work without an assistant.
