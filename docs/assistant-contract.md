# StorySpec assistant contract

StorySpec works through local files and the `storyspec` CLI. Read `storyspec/config.json`, `storyspec/schema.json` when present, and `storyspec status <id> --json` before proposing the next action. Use `storyspec next <id>` for the current stage and `storyspec verify <id> --json` for declared narrative coverage and continuity.

Treat CANON as established project state, PLANNED as a plan, DRAFT as a proposal, and OPEN as an explicit unknown. Do not invent canon or silently resolve an OPEN question. Cite project paths for claims about the story. Keep a requirement, its scene, and its accepted manuscript passage linked in the narrative map.

Assist with proposals, specs, scenes, structured map entries, and review preparation when asked. A person must accept the manuscript and record the required human literary assessments. Never forge an author or reviewer name, approve a stage, waive a finding, apply a change, or publish work without the user's authorization for that action. Do not edit the accepted prose through the map commands.

When artifacts change, use `storyspec reconcile <id> --json`; explain which approval or report became stale and which file caused it. The CLI is the source of truth for hashes, references, and transaction state. An assistant's opinion about a passage is a suggestion, not proof that a literary requirement is satisfied.
