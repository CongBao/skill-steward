# Alpha Testing Protocol

Use anonymous or synthetic Skills unless the participant has reviewed what will be visible. Do not upload reports, prompts, or state files.

Target build: `0.5.0-alpha.3`. This is still an Alpha protocol for a local Harness companion, not a Harness or a claim of complete native plugin coverage.

## Alpha.3 test matrix

Run each row from a clean checkout. Manual mutation journeys must use a disposable `HOME`, workspace, and `SKILL_STEWARD_HOME`.

| Area | Executable check | Expected result |
|---|---|---|
| Public contract and CLI version | `CI=true pnpm --filter skill-steward exec vitest run tests/repository.test.ts tests/binary.test.ts` | Both READMEs use `--plan <id> --confirm`, help exposes the same syntax, and the binary reports `0.5.0-alpha.3`. |
| Exact reviewed plans | `CI=true pnpm --filter skill-steward exec vitest run tests/install.test.ts tests/govern.test.ts tests/evidence.test.ts` | Plans survive a new process, apply the inspected payload once, stop on drift, and require a fresh preview after claim. |
| Integration readiness and serialization | `CI=true pnpm --filter skill-steward exec vitest run tests/integrate.test.ts tests/integrate-process.test.ts` | Apply writes an initial cached portfolio; a failed readiness scan rolls back safe new artifacts; a busy caller does not consume its plan. |
| Package trust | `CI=true pnpm --filter skill-steward exec vitest run tests/package.test.ts tests/runtime-audit.test.mjs tests/verifier.test.mjs` | Package `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and the locked `runtime-audit.json` agree; real npm and pnpm tarballs pass exact-tree verification. |
| Full repository | `CI=true pnpm check` | Every workspace builds, typechecks, and passes its test suite without writing private task content. |

## Build and first run

Before judging repository behavior through a global install, compare `skill-steward --version` with `packages/cli/package.json`; both must report `0.5.0-alpha.3`. Repack and reinstall if they differ. The documented pack command must rebuild workspace dependencies from a clean checkout; do not rely on a prior `pnpm build`. Start once with a clean `SKILL_STEWARD_HOME` and confirm the first-use path explains scan, Preflight, and dashboard without assuming existing state.

Scan an empty set of Skill roots. The result must be unscored and actionable: it must not report health 100. KPI settings must use the current dashboard snapshot and must not present example values as current measurements.

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
4. Ask whether **Use now**, **Consider installing**, and **Capability gaps** changed the next action they would take.
5. For one available candidate, open the installation inspection but do not confirm it. Record whether source, revision, scripts, findings, destination, and exact changes are sufficient for a decision.
6. Run a PDF task against PDF and docx candidates, including a docx description that explicitly excludes PDF work. Algorithm v4 must not recommend docx for that task.
7. Run a generic one-term match against a project-scoped Skill. It must remain excluded unless stronger task evidence or a name match exists.
8. Inspect normal CLI output for a run ID, readable reasons, a bounded excluded section, and a direct feedback command. Keep complete reason codes in `--json` output.

## Reviewed installation concurrency

In a disposable HOME, create two different replacement plans for the same installed Skill while both plans still name its original fingerprint. Start the larger copy first and apply the second plan after the first temporary copy appears. Exactly one process must succeed. The waiter must stop with `DESTINATION_DRIFT`; installation history must contain one committed record, and that record's backup must still match the original fingerprint. Repeat commit and rollback through the Dashboard while another portfolio mutation owns the state lease; both must wait or return the retryable `INSTALLATION_BUSY` conflict instead of bypassing serialization.

## Harness bridge

Always review the plan before apply:

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex --json
skill-steward integrate apply --plan <id> --confirm
```

Use the `id` emitted by the plan command. Confirm that apply writes `latest-report.json` before it reports ready, then submit one synthetic task in the Harness. The first Hook must return quickly from that cached portfolio without a separate manual scan. The Harness must continue if Skill Steward state later becomes missing, and the recommendation may contain installed/available names but not raw task text or source URLs.

Force the initial report write to fail in a disposable state directory. The readiness scan failure must roll back configuration and a companion Skill created by this apply when safe. If another process holds the integration mutation lease, the second call must report busy and does not consume the plan; after the lease is released, the same plan remains applicable. Run two same-Harness apply processes with different plans and confirm exactly one succeeds while the stale plan stops on drift.

Repeat against the declared capability matrix:

- Codex: `UserPromptSubmit` returns recommendation context; `Stop` returns valid non-blocking JSON.
- Claude Code: `UserPromptSubmit` returns recommendation context; `Stop` and `SessionEnd` return valid non-blocking JSON.
- GitHub Copilot CLI: `userPromptSubmitted` and `sessionEnd` both return `{}`; recommendations are tested separately through the companion Skill or CLI.

Remove only the managed entry:

```bash
skill-steward integrate remove --harness codex --confirm
```

Confirm unrelated Hook configuration remains. If cleanup is needed, remove the companion Skill only when it still matches the packaged fingerprint; the normal remove command already performs this check.

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

It seeds installed Skills and cached catalog records, exercises all declared Hook protocols, checks privacy-reduced state and sanitized export, applies all three integration adapters, verifies the shared Skill and configuration, checks drift refusal, and removes managed entries while preserving unrelated configuration.

## Package trust review

Build both artifact forms and run the same verifier used in CI:

```bash
mkdir -p artifacts/npm artifacts/pnpm
pnpm --filter skill-steward pack --pack-destination artifacts/pnpm
(cd packages/cli && npm pack --ignore-scripts --json --pack-destination ../../artifacts/npm)
node packages/cli/tests/verify-packed-artifact.mjs artifacts/npm/skill-steward-*.tgz
node packages/cli/tests/verify-packed-artifact.mjs artifacts/pnpm/skill-steward-*.tgz
```

Inspect the file list for package `README.md`, `LICENSE`, `dist/THIRD_PARTY_NOTICES.txt`, and `dist/third-party-manifest.json`. Confirm every bundled package in the source-controlled `packages/cli/runtime-audit.json` has matching notice coverage and that neither notices nor manifests contain local paths or credentials. Do not update the audit during a normal build.

## Risk boundary

- Exact plans, leases, fingerprints, no-follow path checks, backups, journals, and rollback reduce accidental or detected local drift; they are not an isolation boundary from a malicious process running as the same operating-system user.
- A plan is intentionally single-use after claim. A crash or validation failure can require a fresh preview even when no domain mutation committed.
- A rollback-incomplete error means Skill Steward retained state because it could not prove that removing or overwriting it was safe. Inspect the named files before retrying.
- Catalog metadata and known publisher labels are not endorsements. Installation still reinspects the recorded revision.
- Inventory support for 30 root conventions does not imply complete native plugin inventory or prompt-Hook support. The capability matrix remains the integration boundary.

## Advancement criteria

Ranking calibration remains out of scope until there are at least 100 labeled preflights, 30 corrected candidate sets, 20 portfolio fingerprints, a useful-label rate of at least 60%, no detected raw-content persistence, no unresolved governance failure that loses or overwrites a Skill, and a still-valid Harness capability matrix. Meeting these thresholds allows a separate calibration review; it does not change ranking automatically.
