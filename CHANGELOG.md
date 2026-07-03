# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning once stable releases begin.

## [Unreleased]

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
