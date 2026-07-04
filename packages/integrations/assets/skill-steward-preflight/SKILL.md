---
name: skill-steward-preflight
description: Use when a task may benefit from installed or not-yet-installed Agent Skills and Skill Steward is available in the current Harness.
---

# Skill Steward Preflight

Run `skill-steward preflight --stdin --compact-json` with the exact user task on standard input. When the current Harness is known, pass its ID with `--harness` (`codex`, `claude`, or `github-copilot`).

1. Use the recommendations in the `use` array for the current task.
2. Present recommendations in the `install` array as approval-required options; never install them automatically.
3. Treat capability gaps as search hints, not proof that a capability is unavailable.
4. Before installing a recommendation, run `skill-steward install --catalog-candidate <id> ...` without `--confirm` and show the plan.
5. Add `--confirm` only after the user approves that exact plan.

Do not refresh catalogs unless the user approves the network action. Do not describe publisher classification as a safety guarantee. If Skill Steward fails, continue with the Harness normally and report the failure briefly.
