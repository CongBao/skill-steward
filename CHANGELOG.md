# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning once stable releases begin.

## [Unreleased]

## [0.5.0-alpha.3] - 2026-07-03

### Added

- CLI installation, governance, integration apply, evidence-policy, and evidence-erasure now use exact, single-use reviewed plans that persist privately across processes and apply only through the emitted `--plan <id> --confirm` command.
- Catalog installation retains the inspected source in private staging until apply or expiry, then rechecks source, destination, route, provenance, and filesystem safety without restaging from the network.
- Managed integration apply persists an initial portfolio scan before reporting ready, rolls back safely on readiness failure, and serializes CLI and dashboard mutations through a private cross-process lease without consuming a waiting plan.
- Integration history uses private immutable journal fragments with bounded recovery and cleanup rather than concurrent rewrites of one shared record.
- Preflight evidence preserves normalized Harness and CLI/dashboard/Hook delivery attribution while continuing to exclude raw task content.

### Changed

- Preflight algorithm v4 routes Simplified- and Traditional-Chinese tasks with word-level concepts and filters generic workflow language, preventing unrelated Skills from matching through common single characters while preserving explainable deterministic scoring. Evidence uses a distinct numeric identity when the Node ICU/CLDR/Unicode segmentation runtime differs from the verified reference.

### Distribution

- The CLI package now ships a package README, MIT license, deterministic complete third-party notices, and complete repository metadata.
- CI and local package tests verify real npm and pnpm tarballs against the trusted package tree and source-controlled runtime audit, including exact files, manifest semantics, runtime bytes, license attribution, and hostile archive metadata.

### Security

- Reviewed plans use strict private envelopes, atomic single-use claim, bounded fail-safe cleanup, and domain fingerprint revalidation; a claimed plan that fails validation is not silently regenerated.
- Integration readiness, journal commit, compensation, and shared companion cleanup preserve original failures and report rollback-incomplete state when safe recovery cannot be proven.

### Limitations

- This remains an Alpha release. Native workflow adapters remain limited to Codex, Claude Code, and the documented observe-only GitHub Copilot CLI path; the broader root catalog does not imply complete plugin inventory or Hook coverage.

## [0.5.0-alpha.2] - 2026-07-03

### Changed

- Preflight algorithm v3 addresses observed deterministic-routing failures with safer Latin normalization, narrow English negative-routing clauses, boundary-safe Skill-name matching, and a two-term minimum for non-name matches.
- Human Preflight output now leads with the run ID and readable reasons, bounds excluded-candidate detail, and points to an explicit CLI feedback command backed by the existing evidence store.
- Portfolio surfaces use affected Skill names, treat an empty scanned portfolio as unscored, and use current KPI values instead of synthetic preview numbers.
- Governance human output prefers Skill display names while exact identifiers and fingerprints remain available in plans and JSON.
- The bilingual README now defines the product through its three user jobs and gives a shorter first-use path; the product-review record separates implemented changes from accepted future gaps.
- Direct CLI packing rebuilds workspace dependencies, and CI verifies that path from a clean checkout.
- Dashboard request failures are distinct from genuine empty portfolio, finding, and history states; Preflight scope labels are localized.

### Security

- Human Preflight and governance output escapes terminal control and bidirectional formatting characters from untrusted Skill metadata and filesystem paths.

## [0.5.0-alpha.1] - 2026-07-03

### Added

- Local privacy-safe recommendation evidence with explicit feedback, correction metrics, provenance-only install conversion, lifecycle reasons, Harness/algorithm breakdowns, and 7/30-day windows.
- Minimal and opt-in learning policies with reviewed changes, bounded HMAC-pseudonymous lifecycle events, sanitized export, compaction, and exact erasure.
- Codex and Claude Code recommend-and-observe lifecycle adapters plus an explicit GitHub Copilot CLI observe-only adapter and shared capability matrix.
- Reviewed reversible quarantine and restore through CLI, loopback API, and dashboard, with verified vault copies, drift refusal, transaction history, and failure recovery.
- Evidence, Data Policy, active/quarantined Skill, governance-plan, and three-Harness capability surfaces in the bilingual dashboard.

### Privacy

- Adversarial prompt, transcript, raw-ID, path, assistant, and tool-data canaries are tested across persisted evidence, sanitized export, API, and UI fixtures.
- The private per-install HMAC salt is never included in sanitized export, API responses, or UI output.

### Changed

- Preflight persistence uses schema v3 numeric feature snapshots in learning mode while retaining deterministic algorithm version 2 behavior and performance budgets.
- CLI integration status and companion-Skill cleanup now include Codex, Claude Code, and GitHub Copilot CLI consistently.

### Limitations

- Lifecycle completion is an operational proxy, not task success.
- Evidence readiness does not change ranking weights or thresholds automatically.
- GitHub Copilot CLI is observe-only; recommendations use the companion Skill or explicit CLI preflight.

## [0.4.0-alpha.1] - 2026-07-03

### Added

- Federated, opt-in metadata discovery for OpenAI Plugins, Anthropic Skills, Awesome GitHub Copilot, and custom public HTTPS Git sources.
- Preflight v2 decisions for installed Skills, reviewed installation candidates, capability gaps, and exclusions with Harness compatibility and installation penalties.
- Cached, fail-open `UserPromptSubmit` Hook adapters for Codex and Claude Code plus a shared companion Skill for manual Harness workflows.
- Transactional Harness configuration plans with backups, native trust status, drift detection, and reversible removal.
- Catalog candidate reinspection at the recorded revision before the existing reviewed installation flow can be committed.
- Dashboard controls for source refresh and Harness integrations, backed by the same services as the CLI and Hook paths.

### Privacy

- Catalog network access occurs only during an explicit refresh; task-time Hooks use local cached metadata.
- Preflight evidence v2 retains candidate/source IDs and numeric scores but excludes raw tasks, terms, descriptions, reasons, URLs, and local paths.

### Changed

- Replaced the deprecated `openai/skills` preset with `openai/plugins` while preserving existing opt-in state.

### Limitations

- Native prompt-Hook management currently covers Codex and Claude Code only.
- Task routing remains deterministic and does not yet learn from real Harness outcomes.

## [0.3.0-alpha.1] - 2026-07-03

### Added

- Deterministic task preflight with bilingual Latin/CJK routing analysis and explainable minimal Skill-set recommendations.
- Task-specific relevance, unique coverage, risk, redundancy, scope fit, context estimates, and projected portfolio conflicts.
- Local Preflight dashboard route, token-protected APIs, and CLI support for direct text, UTF-8 files, and stdin.
- Bounded privacy-preserving evidence and useful/incomplete/incorrect feedback without persisting raw task text or extracted terms.

## [0.2.0-alpha.1] - 2026-07-02

### Added

- Local Audit Cockpit dashboard with Chinese and English copy and system/light/dark appearance.
- Fluid wide-to-narrow layout with a manually collapsible sidebar.
- Sixteen deterministic KPI definitions with configurable home selection and count.
- Discovery for 30 harnesses plus shared `.agents/skills` and user/project aliases.
- Local folder, ZIP, and public HTTPS Git inspection.
- User-confirmed installation plans, atomic create/replace, automatic backups, transaction history, and drift-guarded rollback.
- Loopback-only API, bounded scan history, CLI dashboard launcher, and packaged Web assets.

## [0.1.0-alpha.1] - 2026-07-02

### Added

- Deterministic Skill discovery, parsing, fingerprinting, structural findings, overlap analysis, reports, labels, CLI commands, and alpha testing protocol.
