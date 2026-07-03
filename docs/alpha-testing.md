# Alpha Testing Protocol

Use anonymous or synthetic Skills unless the participant has reviewed what will be visible. Do not upload reports, prompts, or state files.

## Portfolio audit

1. Run `skill-steward scan` without explaining individual findings first.
2. Record time to the first finding the participant considers useful.
3. Ask them to label each warning-or-higher finding as useful, incorrect, unclear, or already known.
4. Record which reviewed action they would take if undo were available.

## Discovery preflight

1. Keep all catalog sources disabled and run an installed-only baseline.
2. Let the participant choose a public source, then enable and refresh it explicitly.
3. Run the same task with available candidates enabled.
4. Ask whether **Use now**, **Consider installing**, and **Capability gaps** changed the next action they would take.
5. For one available candidate, open the installation inspection but do not confirm it. Record whether source, revision, scripts, findings, destination, and exact changes are sufficient for a decision.

## Harness bridge

Always review the plan before apply:

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex --json
skill-steward integrate apply --harness codex --confirm
```

Submit one synthetic task in the Harness. Verify that the Hook returns quickly, the Harness continues if Skill Steward state is missing, and the recommendation contains installed/available names but not raw task text or source URLs.

Remove only the managed entry:

```bash
skill-steward integrate remove --harness codex --confirm
```

Confirm unrelated Hook configuration remains. If cleanup is needed, remove the companion Skill only when it still matches the packaged fingerprint; the normal remove command already performs this check.

## Temporary-HOME smoke test

The packaged test suite runs the full cached path without touching the real home directory:

```bash
CI=true pnpm --filter @skill-steward/integrations build
CI=true pnpm --filter @skill-steward/dashboard-server build
CI=true pnpm --filter skill-steward test -- tests/binary.test.ts
```

It seeds an installed Skill and cached catalog record, invokes the Codex Hook JSON protocol, checks privacy-reduced state, applies the integration, verifies the shared Skill and configuration, and removes the managed entry while preserving unrelated configuration.

## Advancement criteria

The next phase requires at least 100 labeled findings across 20 portfolios, actionable precision of at least 60%, 30 reviewed available-candidate decisions, and no unresolved case where apply/remove overwrote unrelated configuration or stored raw task text.
