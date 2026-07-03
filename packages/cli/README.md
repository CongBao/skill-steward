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

The dashboard, CLI, and supported Harness integrations use the same local state. Governance and installation actions show an exact plan first and require explicit confirmation; quarantine, restore, and managed integrations are reversible.

Mutation previews print a copyable apply command. Use the emitted ID rather than repeating the original request:

```bash
skill-steward install --plan <id> --confirm
```

The same `--plan <id> --confirm` contract applies to integration apply, evidence-policy, evidence-erasure, quarantine, and restore plans. Plans are private, expiring, and single-use. Integration removal remains an explicit Harness-scoped action:

```bash
skill-steward integrate remove --harness <id> --confirm
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
