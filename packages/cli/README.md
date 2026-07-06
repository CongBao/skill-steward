# Skill Steward

Skill Steward is a local-first companion for Agent Skill discovery, task preflight, and reversible governance across AI coding Harnesses. It helps you understand the Skills already on your machine, choose a small set for the task at hand, and review changes before applying them.

It is not a Harness, and it does not install recommendations automatically.

> Status: Alpha. This package is currently verified as a local tarball; registry publication is not part of this release.

## Install

```bash
npm install --global ./skill-steward-*.tgz
skill-steward --version
```

Node.js 22 or newer is required.

## Five-minute start

Scan the local Skill portfolio, preflight a real task for an explicit Harness, and open the dashboard:

```bash
skill-steward scan
skill-steward preflight \
  --task 'Review this repository for security risks' \
  --harness codex
skill-steward dashboard
```

Available catalog recommendations always show their Candidate ID. With an explicit supported Harness, human output also prints a complete reviewed preview command. An unknown catalog scope defaults only to the current project with `--scope project`; the CLI resolves the omitted workspace to the current directory. Skill Steward does not guess a Harness or widen that destination to global scope. The preview creates a plan but does not install anything.

The dashboard and CLI use the same local state. Governance, installation, and Harness integration actions show an exact plan first and require explicit confirmation; installation rollback, integration rollback, quarantine, restore, shared-consumer disconnect, and final uninstall are reversible or fail closed with recovery evidence.

Mutation previews print a copyable apply command. Use the emitted ID rather than repeating the original request:

```bash
skill-steward install --plan <id> --confirm
```

The same `--plan <id> --confirm` contract applies to evidence-policy, evidence-erasure, quarantine, and restore plans. Plans are private, expiring, and single-use.

`skill-steward integrate status --json` returns schema v3 and inspects the Harness Hook and shared companion Skill in separate nested domains; the old Alpha top-level status aliases are no longer emitted. `skill-steward integrate plan --harness <id>` creates the reviewed change. Apply accepts only the emitted single-use plan, revalidates it under a state-scoped cross-process lease, and transactionally publishes the companion, Hook configuration, readiness report, and history record. A definite pre-finalize failure restores the exact prior state; uncertainty or failed compensation retains recovery evidence and returns `recovery-required`.

```bash
skill-steward integrate apply --plan <id> --confirm
```

Installation, integration, and rollback share the same mutation lease. A concurrent stale plan stops on drift instead of overwriting a newer commit. Companion create and upgrade also require the packaged no-replace native helper for the current platform.

Disconnect retains the companion while another proven Harness uses it. The last disconnect removes only the exact recorded tree; modified or unproved content is left untouched:

```bash
skill-steward integrate remove --harness <id>
skill-steward integrate remove --plan <id> --confirm
```

If a managed integration was interrupted, inspect the global recovery state before creating another integration plan. Skill Steward derives the only supported rollback or finalize direction from persisted evidence; there is no direction selector or force flag.

```bash
skill-steward integrate recovery status --json
skill-steward integrate recovery plan
skill-steward integrate recovery apply --plan <id> --confirm
```

Recovery plans are expiring and single-use. Apply revalidates exact local evidence under the same mutation lease. Uncertain evidence exposes no recovery action, and an incomplete recovery asks for a fresh review instead of claiming success. Recovery mutation remains POSIX-only; Windows runs native read/fail-closed CI gates but does not yet have the reparse and handle-relative mutation authority needed for writes.

## Package trust

The tarball includes this package `README.md`, the project `LICENSE`, generated `dist/THIRD_PARTY_NOTICES.txt`, and a machine-readable third-party manifest. Package tests verify real npm and pnpm tarballs against the trusted build tree and the source-controlled `runtime-audit.json`, including executable and Web asset bytes. Normal builds validate the runtime audit but never update it implicitly.

## Learn more

Full documentation, security notes, supported Harness details, and contribution guidance are available in the [Skill Steward repository](https://github.com/CongBao/skill-steward).

## Maintainer runtime audit

`runtime-audit.json` is a generated full runtime bundle audit, not a manually curated partial package list. Normal builds and CI only verify it. After intentionally changing runtime dependencies, review the generated notices and update the source-controlled lock explicitly:

```bash
pnpm --filter skill-steward runtime-audit:update
```

Commit the resulting audit diff only after reviewing every package, attribution source, and license-text digest.
