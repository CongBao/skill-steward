# Skill Steward

Skill Steward is a local-first companion for Agent Skill discovery, task preflight, and reversible governance across AI coding Harnesses. It helps you understand the Skills already on your machine, choose a small set for the task at hand, and review changes before applying them.

It is not a Harness, and it does not install recommendations automatically.

> Status: Alpha. This package is currently verified as a local tarball; registry publication is not part of this release.

## Install

```bash
npm install --global ./skill-steward-*.tgz
```

Node.js 22 or newer is required.

## Five-minute start

Scan the local Skill portfolio:

```bash
skill-steward scan
```

Run task preflight without storing the raw task text:

```bash
printf '%s' 'Review this repository for security risks' | skill-steward preflight --stdin
```

Open the local dashboard:

```bash
skill-steward dashboard
```

The dashboard and CLI use the same local state. Governance, installation, and Harness integration actions show an exact plan first and require explicit confirmation; installation rollback, integration rollback, quarantine, restore, and disconnect are reversible or safely retained.

Mutation previews print a copyable apply command. Use the emitted ID rather than repeating the original request:

```bash
skill-steward install --plan <id> --confirm
```

The same `--plan <id> --confirm` contract applies to evidence-policy, evidence-erasure, quarantine, and restore plans. Plans are private, expiring, and single-use.

`skill-steward integrate status --json` and `skill-steward integrate plan --harness <id>` inspect the Harness Hook and shared companion Skill separately. Apply accepts only the emitted single-use plan, revalidates it under a state-scoped cross-process lease, and transactionally publishes the companion, Hook configuration, readiness report, and history record. A definite pre-finalize failure restores the exact prior state; uncertainty or failed compensation retains recovery evidence and returns `recovery-required`.

```bash
skill-steward integrate apply --plan <id> --confirm
```

Installation, integration, and rollback share the same mutation lease. A concurrent stale plan stops on drift instead of overwriting a newer commit. Companion create and upgrade also require the packaged no-replace native helper for the current platform.

Disconnect removes only the reviewed managed Hook and retains the shared companion Skill so another Harness cannot lose it:

```bash
skill-steward integrate remove --harness <id>
skill-steward integrate remove --plan <id> --confirm
```

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
