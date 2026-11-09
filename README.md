# StorySpec

StorySpec is a local, editor-independent narrative specification framework for novels and light novels. It has no built-in fictional universe, AI provider, or remote service. Node.js 20+ is required. [Leia em português](README.pt-BR.md).

## Install and start

```sh
npm install -g git+https://github.com/elaranjo/StorySpec.git
mkdir my-novel && cd my-novel
storyspec init "My novel" --profile novel
```

Use `--lang pt-BR` for Portuguese. English is the default. Profiles are `generic`, `novel`, and `light-novel`. They share one workflow; the light novel profile adds optional volume pacing, visual beats, and illustration prompts, with no length rule. The project language and profile are stored in `storyspec/config.json`. `storyspec help` lists every command.

## Narrative change cycle

**Propose → specify → plan → write → accept manuscript → verify → review → approve → apply → archive.** Everything is local. `storyspec status <id> --json` shows artifacts, blockers and the next action; `storyspec next <id>` gives the next command and path without editing content.

```sh
storyspec new chapter chapter-one
storyspec new scene chapter-one opening
storyspec new delta chapter-one plot
```

Fill `proposal.md`, `design.md`, `chapter-contract.md`, the scene, and the delta in `storyspec/changes/chapter-one/`. Add project-relative Markdown paths under optional `Sources` lists in the proposal and design when they inform the plan. The chapter contract and scene fields are configurable in `storyspec/config.json`. Then:

```sh
storyspec validate chapter-one
storyspec approve chapter-one plan --author "Writer"
storyspec context chapter-one --scene opening --purpose write
```

The plan approval is required before `context --purpose write`. Write your draft in `draft.md` or your own editor. Complete the task checkboxes and use `storyspec map` commands to link requirements, scenes, and accepted passages. Accept the manuscript, record narrative verification, then fill and record the human reviews:

```sh
storyspec manuscript accept chapter-one manuscript/chapter-one.md --author "Writer"
storyspec map scene set chapter-one opening --order 1 --origin "The opening choice"
storyspec map coverage set chapter-one plot/costly-choice --status realized
storyspec map passage add chapter-one plot/costly-choice --scene opening --lines 3:3
storyspec verify chapter-one --record
storyspec review chapter-one dramaturgy
storyspec review chapter-one dramaturgy --record --author "Reviewer"
storyspec review chapter-one continuity
storyspec review chapter-one continuity --record --author "Reviewer"
storyspec review chapter-one prose
storyspec review chapter-one prose --record --author "Reviewer"
storyspec approve chapter-one final --author "Writer"
```

A review JSON file needs `verdict` (`PASS` or `BLOCK`), `summary`, a nonempty `evidence` path list, `findings`, and `waivers`. Each finding has an ID, severity `BLOCKER` or `NOTE`, and text. A blocking finding needs a waiver with its finding ID, declared author, and reason before final approval. Recording a review stores hashes and local copies of its cited evidence. AI may assist a human reviewer but is optional. The CLI validates structure and references; it cannot judge literary quality or verify who signed.

StorySpec records the manuscript path and SHA-256 hash and never edits the prose. Preview the controlled changes, apply, and archive:

```sh
storyspec apply chapter-one --dry-run
storyspec apply chapter-one
storyspec archive chapter-one
```

`apply` updates approved specs, staged claims, and the narrative scene index in one transaction. A failed or interrupted application leaves a transaction journal; run `storyspec apply --recover chapter-one` to restore the previous controlled files, or complete the receipt if the state was already committed. `archive` marks the change `ARCHIVED` in its original `storyspec/changes/chapter-one/` directory after application and manuscript acceptance, so cited paths remain valid. `storyspec history chapter-one` locates both current changes and archives moved by version 0.6. Public distribution is described below.

For a change without manuscript, use `storyspec new change travel-rule --type world` (also `character` or `plot`), then `new delta`. Its required reviews are dramaturgy and continuity; no manuscript acceptance is needed. `revision` changes require manuscript acceptance and all three reviews.

## Narrative map and verification

New changes contain `narrative-map.json` (workflow version 3, map version 2). Every `ADDED` or `MODIFIED` requirement needs one `coverage` entry. `deferred` needs `defer.target` and `defer.reason`; `partial` needs those plus a scene and accepted manuscript passage; `realized` needs a scene and passage. Each version 2 `links` entry pairs one scene with one accepted passage. A passage records `path`, accepted manuscript `hash`, `startLine`, and `endLine` (1-based). For a change without manuscript, use a justified deferral. `storyspec verify <id> --json` reports coverage and continuity issues; `--record` stores the report for final approval.

Each scene has an ID local to the change, a unique `narrativeOrder`, `storyAfter` and `causedBy` arrays of keys such as `chapter-one/opening`, an optional `originReason`, plus `stateChanges` and `knowledgeChanges`. `storyAfter` describes event order independently of presentation order. A state transition uses `{ "entity": "storyspec/characters/hero.md", "field": "location", "from": "home", "to": "road" }`; a knowledge transition uses `{ "character": "hero", "claim": "storyspec/claims/fact/secret.md", "from": "UNAWARE", "to": "KNOWS" }`. The applied index lives in `storyspec/narrative-state.json`. A waivable narrative issue may be listed in `waivers` with `issueId`, `author`, and `reason`. File, reference, and hash errors cannot be waived. Human reviews still judge dramaturgy and prose. The dramaturgy report must assess every realized or partial requirement with a reasoned `requirementAssessments` verdict.

Existing changes retain their original workflow. `storyspec map init <id>` opts a change without a map into version 2; `storyspec map upgrade <id>` upgrades an active version 1 map when its scene and passage pairs are unambiguous. Both invalidate affected approvals without rewriting narrative documents.


## Guided authoring and assistants

`storyspec/schema.json` defines artifact dependencies, templates, and completion checks. Novel and Light Novel are presets. Additional Markdown artifacts may be declared under `extras/` for the plan or final stage; run `storyspec schema validate` after editing the schema. The approval hashes include the schema and applicable custom artifacts. `storyspec reconcile <id> --json` explains stale decisions after edits or parallel changes.

The [step-by-step tutorial](docs/tutorial.md) and [four complete examples](examples/README.md) cover both profiles in EN/PT. Assistant use is optional: `storyspec adapters install codex|claude|cursor --dry-run` previews project-local instructions; omit `--dry-run` to install. All three follow the same [assistant contract](docs/assistant-contract.md).

## Specs and claims

Active narrative requirements live in `storyspec/specs/<domain>/spec.md`. A change proposes `ADDED`, `MODIFIED`, and `REMOVED` sections in `storyspec/changes/<id>/specs/<domain>/spec.md`. These markers and field names stay in English in both languages; the narrative text may be English or Portuguese. Each requirement has a stable ID, scope, status (`CANON`, `PLANNED`, or `OPEN`), statement, verification condition, and optional source and claim references. `MODIFIED` supplies a full replacement; `REMOVED` supplies an ID and reason. Applied requirements record `Origin: <change-id>`.

```md
# Delta: plot

## ADDED

### Requirement: costly-choice
Scope: volume
Status: PLANNED
Statement: The protagonist's choice must cause a visible loss.
Verification: The chapter ending shows the loss.
Sources:
Claims:

## MODIFIED

## REMOVED
```

Claims are separate atomic facts about the fictional world or a character's knowledge. Use `storyspec new claim ...` for a draft claim. Stage a controlled change with `storyspec new claim-delta <change> <fact|knowledge|clue|event> <id> --operation ADDED|MODIFIED|REMOVED`; fill the staged Markdown and set a proposed applied claim to `CANON`, with a source. A spec can reference a claim without duplicating its statement. Imported Markdown sources remain `UNCLASSIFIED`; importing never canonizes them.

Plan and final approvals store a declared name, timestamp, and content hash. The plan receipt lists hashes of its artifacts, affected base specs and claims (including absent new files), and structured `Sources` and `Claims` references. Cited files and review evidence are copied locally to `evidence/sha256/` by content hash. Editing an approved plan, base file, source, task list, review, evidence, or draft invalidates the relevant approval and reports the differing path. An unrelated domain change does not invalidate the plan. `apply` checks the recorded controlled-state hashes and refuses conflicting manual edits. After application, historical checks use the preserved evidence copies, so later edits to original sources do not prevent archiving. The local approval record is an audit trail, not identity verification or access control.

## Existing projects

`storyspec migrate --dry-run` previews a format 1–3 migration; `storyspec migrate` upgrades the config to format 4 and backs it up under `storyspec/archive/migrations/`. Existing narrative documents are not rewritten. Before the first controlled application, run `storyspec baseline approve --author "Writer"` to ratify the current CANON records and their hashes. Migration does not invent retroactive approvals. Existing projects without a language setting retain Portuguese.

## Distribution

`npm test` runs local tests. `npm pack` creates an installable package file; install it with `npm install -g git+https://github.com/elaranjo/StorySpec.git/storyspec-0.8.0.tgz`. The package is distributed from GitHub; it is not published to the npm registry. License: MIT.
