# Alpha Testing Protocol

Use anonymous or synthetic Skills unless the participant has reviewed what will be visible. Do not upload reports, prompts, or state files.

Target build: `0.5.0-alpha.4`. This is still an Alpha protocol for a local Harness companion, not a Harness. Native semantics are tested only on the documented core adapter surfaces below.

## Current test matrix

Run each row from a clean checkout. Manual mutation journeys must use a disposable `HOME`, workspace, and `SKILL_STEWARD_HOME`.

| Area | Executable check | Expected result |
|---|---|---|
| Public contract and CLI version | `CI=true pnpm --filter skill-steward exec vitest run tests/repository.test.ts tests/binary.test.ts` | Both READMEs state the bounded native/compact contracts, help exposes reviewed-plan syntax, and the binary reports `0.5.0-alpha.4`. |
| Native adapter coverage and current-workspace snapshot limitation | `CI=true pnpm --filter @skill-steward/engine exec vitest run tests/codex-inventory.test.ts tests/claude-inventory.test.ts tests/copilot-inventory.test.ts tests/inventory-workspace.test.ts tests/visibility-resolution.test.ts` | Documented local sources reach exact terminal statuses; Harness coverage and Skill exposure resolve separately; scans cover the chosen workspace ancestors and user scopes without crawling unrelated workspaces. |
| Compact handoff output and bilingual concept matching | `CI=true pnpm --filter @skill-steward/preflight exec vitest run tests/analyze.test.ts tests/tokenize.test.ts tests/compact.test.ts` | Algorithm v8/result schema v4 preserves visibility and recommendation decisions, compact schema v3 stays within 4,096 UTF-8 bytes and nulls unavailable feedback, the bounded pre-merge review profile resists generic names and negation, and low-confidence two-character fragments remain empty. |
| Native governance refusal | `CI=true pnpm --filter skill-steward exec vitest run tests/govern.test.ts tests/preflight.test.ts` | Native plugin-managed Skills remain visible but cannot enter quarantine/restore plans; direct Skills remain eligible; compact CLI output stays bounded. |
| Exact reviewed plans | `CI=true pnpm --filter skill-steward exec vitest run tests/install.test.ts tests/govern.test.ts tests/evidence.test.ts` | Plans survive a new process, apply the inspected payload once, stop on drift, and require a fresh preview after claim. |
| Integration lifecycle and public surfaces | `CI=true pnpm --filter @skill-steward/integrations test && CI=true pnpm --filter @skill-steward/store test && CI=true pnpm --filter skill-steward exec vitest run tests/integrate.test.ts tests/integrate-process.test.ts && CI=true pnpm --filter @skill-steward/dashboard-server exec vitest run tests/integrations.test.ts` | Plans bind exact Hook, companion, source, proof, record-head, and consumer evidence; create/upgrade/no-op/disconnect use the same recoverable coordinator across CLI, API, and Dashboard; rollback and uncertainty remain safe and path-free. |
| Native no-replace packages | `CI=true pnpm --filter skill-steward exec vitest run tests/native-workflow-policy.test.mjs tests/native-package-verifier.test.mjs tests/native-package-publisher.test.mjs tests/package.test.ts` plus the six-package matrix in `.github/workflows/native-rename-packages.yml` | Platform packages expose only the expected ABI and native binary, carry exact OS/CPU/libc metadata and a four-file tarball, and use exact-SHA-pinned actions. Exact-main publication preflights all six registry integrities and safely resumes only byte-identical partial publication through the protected `native-publish` environment. The publish job verifies its pinned npm 11 client. The [publication runbook](native-publication.md) limits token use to the one-time package bootstrap; later releases use trusted publishing. |
| Lifecycle journal snapshot races | `CI=true pnpm --filter @skill-steward/store exec vitest run tests/integration-store.test.ts` | Concurrent cleanup retries only after immediate path absence is proven; same-name replacement still fails closed; real readers remain healthy while writers publish and clean beyond 100 fragments. |
| Windows journal compatibility | `pnpm --filter @skill-steward/store exec vitest run tests/integration-store.windows.test.ts` on Windows | Journal append/read/bounds, junction refusal, and lease recovery pass using exact native identity and containment. The implementation does not call unsupported Windows directory `fsync`, and public integration mutation remains unavailable. |
| Package trust | `CI=true pnpm --filter skill-steward exec vitest run tests/package.test.ts tests/runtime-audit.test.mjs tests/verifier.test.mjs` | Package `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and the locked `runtime-audit.json` agree; real npm and pnpm tarballs pass exact-tree verification. |
| Full repository | `CI=true pnpm check` | Every workspace builds, typechecks, and passes its test suite without writing private task content. |

## Build and first run

Before judging repository behavior through a global install, rebuild, repack, and reinstall the current checkout even when `skill-steward --version` already matches `packages/cli/package.json`; two different Alpha builds can share a version before release. Both must report `0.5.0-alpha.4`, but version equality alone is not freshness proof. The documented pack command must rebuild workspace dependencies from a clean checkout; do not rely on a prior `pnpm build`. Start once with a clean `SKILL_STEWARD_HOME` and confirm the first-use path explains scan, Preflight, and dashboard without assuming existing state.

Scan an empty set of Skill roots. The result must be unscored and actionable: it must not report health 100. KPI settings must use the current dashboard snapshot and must not present example values as current measurements.

## Native inventory boundaries

- **Source statuses:** `scanned`, `missing`, `unreadable`, `invalid`, `disabled`, `stale`, `ambiguous`, `truncated`
- **Harness coverage:** `verified`, `partial`, `unavailable`, `convention-only`
- **Skill exposure:** `effective`, `shadowed`, `inactive`, `ambiguous`

Run the native adapter coverage and current-workspace snapshot limitation check from the matrix. For Codex, Claude Code, and GitHub Copilot CLI, inspect the report or Dashboard and confirm each value belongs to the correct taxonomy. Directory count alone is not activation evidence.

Start the scan inside a nested disposable workspace. Confirm the adapter includes that workspace's documented ancestors and user scopes, but not a sibling project that was never selected. For Copilot, remove local runtime or MDM proof and confirm Copilot Harness coverage becomes `partial`. Remove local precedence or activation proof and confirm the affected source or Skill exposure becomes `ambiguous` instead of being guessed active.

Across the total 30 Harnesses, confirm coverage outside the three core adapters is `convention-only` directory inventory/install coverage rather than verified native semantics.

Create one direct Skill and one plugin-managed duplicate. Confirm the plugin instance is read-only: the native governance refusal check must reject quarantine and restore before a plan or event is written, while the direct instance remains eligible. Manage plugin instances through their owning Harness.

## Compact and bilingual Preflight

Run the compact handoff output and bilingual concept matching check from the matrix. Use equivalent Simplified- and Traditional-Chinese tasks about a long session, evolving requirements, context compaction, and preserving intent. Algorithm v8/result schema v4 must select the same relevant concept, keep gap-only aliases out of ranking, and avoid claiming general cross-language semantic understanding. Confirm low-confidence two-character fragments produce an empty route, no name match, and no standalone gap. Confirm negative usage clauses neither corroborate nor cover a gap, while positive candidate aliases and inflections share the task's canonical gap concept. Generic exact names must produce an empty gap list unless they also meet the specific multi-concept evidence gate; specialized single-token and multiword exact names remain valid controls.

Run the exact Phase 2 pre-merge review task. In the unrelated-control fixture, installed `requesting-code-review` must be the only recommendation and must charge exactly its declared 729 context tokens. Add `phase-checklist` and `documentation-review` controls that also say `before merge`; neither may be selected. Repeat with `before. Merge`, `before / merge`, `before — merge`, bounded task `avoid`/`without`, straight and curly `don't`, candidate `Never use`/`Do not invoke`/`Avoid using`, and a task that says `Do not review before merge`; none may create a positive lifecycle trigger, and negated task/routing text must not affect ordinary matching, gap corroboration, or gap coverage. Keep comma/colon lists, hyphens, slashes, em dashes, symbols, and emoji inside negated text; separately prove `, but create ...` and `: create ...` retain explicit positive contrasts. Confirm `Whenever reviewing ... before merge` remains positive, a semicolon-delimited request remains visible, negative code review is not overridden by positive documentation review, positive code review survives a different negative object, and negative route terms cannot push gap evidence over its relevance gate. In a separate fixture, add genuinely relevant `api-privacy-review`; both complementary Skills may be selected and must charge their combined declared context rather than forcing the single-Skill expectation. Human CLI and both dashboard locales must render the lifecycle-trigger reason. Compact schema v3 must expose only the reason code, never the readable detail or task text, and must null feedback when evidence cannot be saved.

For the mixed-object negative case, include both `requesting-code-review` and `receiving-code-review`. Negated code review plus positive documentation review must exclude both code-review workflows, while negated documentation review plus positive code review must leave the requesting workflow eligible. Repeat the inverse in candidate routing: positive documentation routing plus negative code routing must remain excluded with `NEGATIVE_TRIGGER`. Action-named colon lists such as `Do not use: Run, Test, or Build skills`, `Run, and/or Test tools`, `Run/Test/Build skills`, and `Run & Test tools` must remain wholly negative. `Run instead of Build`, `Run and Test instead of Build`, and `Run tools, instead of Build tools` must also stay negative. The single-action PDF-to-DOCX contrast and a standalone-`instead` multi-action DOCX contrast must stay positive.

Pipe one synthetic task through `skill-steward preflight --stdin --compact-json`. Confirm stdout contains exactly one JSON line, is no more than 4,096 UTF-8 bytes, and carries selected use/install recommendations but no raw task. Repeat with `--json`: it must return the complete `PreflightResult`, including candidate reasons and inventory warnings and catalog `source` metadata for available catalog candidates, but not native inventory ownership, plugin, source, or exposure records. Confirm reports and the dashboard preserve those native records, while Preflight expresses resolved visibility through reason codes and inventory warnings. Companion Hook output remains limited to 2,048 bytes.

## Portfolio audit

1. Run `skill-steward scan` without explaining individual findings first.
2. Record time to the first finding the participant considers useful.
3. Ask them to label each warning-or-higher finding as useful, incorrect, unclear, or already known.
4. Record which reviewed action they would take if undo were available.
5. Confirm each report, Overview priority, and Findings row identifies the affected Skill by display name when that name is available.

## Discovery preflight

1. Keep all catalog sources disabled and run an installed-only baseline.
2. Let the participant choose a public source, then enable and refresh it explicitly.
3. Run the same task with available candidates enabled.
4. Ask whether **Use now**, **Consider installing**, and **Capability gaps** changed the next action they would take. Confirm every gap is a plausible Skill search hint, repeated inflections or translations appear once, and low-confidence context produces an empty list without changing the recommendation.
5. For one available candidate, open the installation inspection but do not confirm it. Record whether source, revision, scripts, findings, destination, and exact changes are sufficient for a decision.
6. Run a PDF task against PDF and docx candidates, including a docx description that explicitly excludes PDF work. Algorithm v8 must not recommend docx for that task.
7. Run a generic one-term match against a project-scoped Skill. It must remain excluded unless stronger task evidence or a name match exists.
8. Inspect normal CLI output for a run ID, readable reasons, a bounded excluded section, and a direct feedback command. Keep complete reason codes in `--json` output.

## Reviewed installation concurrency

In a disposable HOME, create two different replacement plans for the same installed Skill while both plans still name its original fingerprint. Start the larger copy first and apply the second plan after the first temporary copy appears. Exactly one process must succeed. The waiter must stop with `DESTINATION_DRIFT`; installation history must contain one committed record, and that record's backup must still match the original fingerprint. Repeat commit and rollback through the Dashboard while another portfolio mutation owns the state lease; both must wait or return the retryable `INSTALLATION_BUSY` conflict instead of bypassing serialization.

## Harness bridge

Run the full journey inside a disposable `HOME` and `SKILL_STEWARD_HOME`:

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex --json
```

Confirm status reports the Hook and companion separately. The plan must include the exact target, packaged source, expected companion tree, proof category, record head, consumer evidence, action, availability, and one copyable apply command. Review and apply that exact plan:

```bash
skill-steward integrate apply --plan <id> --confirm --json
skill-steward integrate status --harness codex --json
```

The result must be `ready`; a create reports `companion: created` and `hook: installed`. Repeat the plan and apply journey without changing files; the `none` action must be a real zero-write path. Seed an older owned companion fixture and verify the upgrade path. After every run, compare the CLI, loopback API, Dashboard, readiness report, and integration history fields.

Review and apply disconnect in two separate commands:

```bash
skill-steward integrate remove --harness codex --json
skill-steward integrate remove --plan <id> --confirm --json
```

The selected Hook must be removed without changing unrelated configuration. The companion remains present. After the last consumer disconnects, reconnect must reuse only a lifecycle-proven retained companion; modify, replace, truncate, or make it unreadable and confirm reconnect stops on drift.

Exercise the cached Hook protocols through temporary-HOME fixtures:

- Codex: `UserPromptSubmit` returns recommendation context; `Stop` returns valid non-blocking JSON.
- Claude Code: `UserPromptSubmit` returns recommendation context; `Stop` and `SessionEnd` return valid non-blocking JSON.
- GitHub Copilot CLI: `userPromptSubmitted` and `sessionEnd` both return `{}`; recommendations are tested separately through the companion Skill or CLI.

For failure coverage, inject final readiness publication failure after the companion and Hook mutations. Both must return to their exact before state and the receipt must report `rolled-back`. Kill a child process after durable recovery intent and rerun the recovery reader. Force a lease loss at a forward mutation boundary and confirm `recovery-required` is path-free and no unsafe overwrite occurs. Unknown `EACCES` and `EIO` errors must use the stable generic public error rather than include a filesystem path.

On every supported platform package, remove the no-replace helper and confirm create/upgrade is blocked before mutation. Disconnect must remain available because it does not mutate the companion tree. A proven existing-parent `none` action may proceed without the helper; a missing config ancestor may not.

## Evidence and privacy

Start in the default minimal mode, run Preflight, and submit one explicit label. Confirm no `evidence-salt` or lifecycle journal is created by minimal-mode Hooks. Then review before enabling learning mode:

```bash
skill-steward evidence feedback --preflight <run-id> --label useful
skill-steward evidence feedback --preflight <run-id> --label incomplete --candidate <complete-correct-candidate-set>
```

For incomplete feedback, include every candidate that should have been recommended, not only the missing item. Confirm both CLI feedback paths update the same privacy-reduced Preflight record used by the dashboard.

```bash
skill-steward evidence policy
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000
skill-steward evidence policy set --plan <id> --confirm
```

Use a synthetic payload containing unique prompt, transcript, raw ID, working-path, assistant-message, tool-argument, and tool-output canaries. Confirm none appear in `preflights.json`, `evidence-events.jsonl`, sanitized export, Evidence API output, or the Evidence dashboard. Confirm the export does not contain the private salt in raw, hex, or base64 form.

Review feedback and correction metrics with their numerator/denominator. Treat lifecycle reasons as proxy signals only; do not report them as task success. A readiness badge does not authorize ranking changes.

Finally, run `skill-steward evidence erase`, inspect the preview, and apply it with `skill-steward evidence erase --plan <id> --confirm`. Confirm only `preflights.json`, `evidence-events.jsonl`, and `evidence-salt` are removed while portfolio, catalog, integration, installation, and governance state remains.

## Reversible governance

Use a synthetic disposable Skill. Run quarantine without `--confirm`, inspect the active/vault paths, fingerprint, aliases, and every operation, then confirm it:

```bash
skill-steward govern quarantine --skill <skill-id>
skill-steward govern quarantine --plan <id> --confirm
skill-steward govern history --json
```

Verify the Skill no longer appears in active discovery and appears as quarantined. Review and confirm restore, then compare the restored fingerprint with the original:

```bash
skill-steward govern restore --transaction <quarantine-id>
skill-steward govern restore --plan <id> --confirm
```

Also test refusal: edit the active source after planning quarantine, occupy the original destination before restore, and alter a disposable vault fixture. Each case must stop without deleting or overwriting the only verified copy. There is no permanent-delete acceptance path.

Normal human output should lead with the Skill display name. Exact IDs, fingerprints, and operation details remain available in plans and JSON for auditing.

## Responsive and locale review

Review English pages with English screenshots and Chinese pages with Chinese screenshots. Exercise the dashboard at 720, 866, 1100, 1280, and 1600 px widths. At each width confirm navigation, decision labels, operation confirmation, tables, and empty states remain readable without hiding safety information.

## Temporary-HOME smoke test

The packaged test suite runs the full cached path without touching the real home directory:

```bash
CI=true pnpm --filter @skill-steward/integrations build
CI=true pnpm --filter @skill-steward/dashboard-server build
CI=true pnpm --filter skill-steward exec vitest run tests/binary.test.ts
```

It seeds installed Skills and cached catalog records, exercises all declared Hook protocols, checks privacy-reduced state and sanitized export, reviews all three integration adapters, and verifies create/upgrade/no-op/disconnect plus rollback, recovery-required, native-capability, and privacy gates through public surfaces.

## Package trust review

Build both artifact forms and run the same verifier used in CI:

```bash
mkdir -p artifacts/npm artifacts/pnpm
pnpm --filter skill-steward pack --pack-destination artifacts/pnpm
(cd packages/cli && npm pack --ignore-scripts --json --pack-destination ../../artifacts/npm)
node packages/cli/tests/verify-packed-artifact.mjs artifacts/npm/skill-steward-*.tgz
node packages/cli/tests/verify-packed-artifact.mjs artifacts/pnpm/skill-steward-*.tgz
```

Inspect the file list for package `README.md`, `LICENSE`, `dist/THIRD_PARTY_NOTICES.txt`, and `dist/third-party-manifest.json`. Confirm every bundled package in the source-controlled `packages/cli/runtime-audit.json` has matching notice coverage and that neither notices nor manifests contain local paths or credentials. The runtime audit must include `jsonc-parser@3.3.1` as MIT and `smol-toml@1.7.0` as BSD-3-Clause; report-only development dependency `marked` must remain absent. Do not update the audit during a normal build.

## Risk boundary

- Exact plans, leases, fingerprints, no-follow path checks, backups, journals, and rollback reduce accidental or detected local drift; they are not an isolation boundary from a malicious process running as the same operating-system user.
- A plan is intentionally single-use after claim. A crash or validation failure can require a fresh preview even when no domain mutation committed.
- A rollback-incomplete error means Skill Steward retained state because it could not prove that removing or overwriting it was safe. Inspect the named files before retrying.
- Catalog metadata and known publisher labels are not endorsements. Installation still reinspects the recorded revision.
- Native semantics are verified only for documented local Codex, Claude Code, and GitHub Copilot CLI surfaces. Copilot Harness coverage may remain `partial` when runtime or MDM proof is unavailable. An affected source or Skill exposure may remain `ambiguous` when activation or precedence is unproven. A scan is a current-workspace snapshot plus user scopes.
- Across the total 30 Harnesses, inventory/install coverage outside the three core adapters is `convention-only`; it does not imply native plugin or prompt-Hook semantics. The capability matrix remains the integration boundary.

## Advancement criteria

Ranking calibration remains out of scope until there are at least 100 labeled preflights, 30 corrected candidate sets, 20 portfolio fingerprints, a useful-label rate of at least 60%, no detected raw-content persistence, no unresolved governance failure that loses or overwrites a Skill, and a still-valid Harness capability matrix. Meeting these thresholds allows a separate calibration review; it does not change ranking automatically.
