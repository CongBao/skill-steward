# Skill Steward

English | [简体中文](README.zh-CN.md)

**Know your Skills. Choose what matters. Change with confidence.**

**One local operations layer for Agent Skills across Codex, Claude Code, and GitHub Copilot CLI.**

**See the portfolio. Preflight the task. Review every change.**

Skill Steward gives your Harness a shared view of installed Agent Skills, recommends the smallest useful set for each task, and makes Skill changes reviewable and recoverable. It works beside Codex, Claude Code, and GitHub Copilot CLI; it does not replace your Harness or run the task itself.

Analysis stays local and deterministic. Skill Steward does not call an LLM. Catalog refresh is opt-in, and prompt-time Preflight uses only the validated local cache.

> **Status: Beta release candidate 0.5.0-beta.1.** The Skill Steward CLI is not published to npm, and there is no GitHub prerelease yet. Publication is paused while the product completes local manual testing. Install the verified local candidate below.

## Three jobs

### 1. Understand your Skill portfolio

Scan user and project Skill directories across 30 Harness conventions. See duplicate content, broken references, context cost, scripts, executables, scope overlap, plugin ownership, and whether a Skill is actually effective or shadowed.

### 2. Preflight the current task

Compare the task with installed Skills and candidates from catalogs you explicitly enable. Results separate **Use now**, **Consider installing**, capability gaps, and exclusions, then choose a small set whose members add distinct value.

### 3. Change Skills safely

Inspect a local folder, ZIP, public Git source, or catalog candidate before installation. Review the exact destination and filesystem plan, then confirm it explicitly. Installation, quarantine, restore, Harness connection, disconnect, rollback, and interruption recovery stop when evidence has drifted.

## The Skill Steward loop

`Inventory → Preflight → Reviewed change → Local evidence → Recovery`

This connected loop is the product: one cross-Harness inventory informs task-time selection; every accepted change keeps provenance and rollback evidence; feedback and lifecycle history show what happened without storing the raw task. Your Harness remains responsible for deciding whether and how to use a recommendation.

## Product views

![Portfolio overview in English](docs/images/overview-light-en.png)

![Task Preflight with installed and available candidates](docs/images/preflight-discovery-light-en.png)

![Reviewed quarantine plan with verified recovery](docs/images/governance-dark-en.png)

The [Chinese README](README.zh-CN.md) uses the matching Chinese interface captures.

## Local installation

Requirements: Node.js 22+, pnpm 10+, and `cc` on macOS/Linux for the lifecycle helper. Windows installs the CLI without that helper.

```bash
git clone https://github.com/CongBao/skill-steward.git
cd skill-steward
pnpm install --frozen-lockfile
pnpm candidate:install
skill-steward --version
```

The candidate installer verifies the CLI and the one native helper for the current platform before installing them together. It does not publish anything. For source-development setup, use [CONTRIBUTING.md](CONTRIBUTING.md).

## First use

```bash
skill-steward scan
skill-steward preflight \
  --task "Review this TypeScript change for security regressions and missing tests" \
  --harness codex
skill-steward dashboard
```

These commands create a local inventory and privacy-reduced evidence under `~/.skill-steward`; they do not install a recommendation or change Harness configuration. Mutations always begin with a preview and require the exact emitted plan ID plus explicit confirmation.

## Verified support

| Harness coverage | Inventory | Task-time integration | Reviewed lifecycle |
|---|---|---|---|
| Codex | Native direct and plugin visibility | Recommend + observe | Supported on proven macOS/Linux paths |
| Claude Code | Native direct and plugin visibility | Recommend + observe | Supported on proven macOS/Linux paths |
| GitHub Copilot CLI | Native direct and plugin visibility | Observe only; recommend through companion Skill/CLI | Supported on proven macOS/Linux paths |
| 27 other Harness conventions | Directory inventory and installation | No verified native Hook behavior | No verified native lifecycle behavior |

The dashboard is bilingual, supports light and dark appearance, and adapts from narrow in-app-browser widths to wide desktop layouts.

## Current boundaries

- Native behavior is verified for Codex, Claude Code, and GitHub Copilot CLI. The wider 30-Harness catalog is convention-based coverage, not a claim of native semantic compatibility.
- Windows supports inventory, Preflight, reports, and the dashboard. Reviewed integration lifecycle writes remain unavailable until native filesystem proof is complete.
- A scan covers the current workspace and user scopes; it does not crawl every project on the machine.
- Native plugin-managed Skills are visible but read-only. Manage them through their owning Harness.
- Preflight is an explainable local ranker, not general semantic understanding. An empty result is preferred to a low-confidence recommendation.
- Catalog sources are disabled by default. Refresh supports credential-free public HTTPS Git sources; a catalog entry is metadata, not a safety endorsement.
- Skill Steward protects reviewed operations against detected drift, but it is not an isolation boundary from another malicious process running as the same operating-system user.

## Learn more

- [Architecture and trust boundaries](docs/architecture.md)
- [Beta candidate testing](docs/alpha-testing.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) and [governance](GOVERNANCE.md)
- [Support](SUPPORT.md) and [private security reporting](SECURITY.md)
- [MIT License](LICENSE)
