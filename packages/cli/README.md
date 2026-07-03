# Skill Steward

Skill Steward is a local-first companion for Agent Skill discovery, task preflight, and reversible governance across AI coding Harnesses. It helps you understand the Skills already on your machine, choose a small set for the task at hand, and review changes before applying them.

It is not a Harness, and it does not install recommendations automatically.

## Install

```bash
npm install --global skill-steward
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

## Learn more

Full documentation, security notes, supported Harness details, and contribution guidance are available in the [Skill Steward repository](https://github.com/CongBao/skill-steward).
