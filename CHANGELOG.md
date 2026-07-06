# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning once stable releases begin.

## [Unreleased]

### Added

- Reviewed Harness integration apply is now active for Codex, Claude Code, and GitHub Copilot CLI across the CLI, loopback API, and dashboard. One single-use plan binds the Hook configuration, packaged companion tree, ownership proof, current record head, consumer set, readiness report, and history record.
- Companion create and upgrade use platform-specific no-replace native operations for supported Darwin and Linux architectures. The six optional packages build in a pinned GitHub Actions matrix; missing or unsupported native capability fails closed before mutation.
- Reviewed disconnect proves the complete post-transition consumer set. It retains the shared companion while another Harness uses it, then removes only the exact recorded installed tree when the last consumer disconnects. A newer package can uninstall an unchanged older tree; modified, unreadable, contradictory, or unproved state stops without force deletion.

### Changed

- Preflight algorithm v9 and full result schema v5 add a bounded English/Chinese developer-workflow capability grammar. Exact action-object evidence can make a safe candidate plausible; greedy selection prefers uncovered capabilities and excludes candidates that add neither a term nor a capability. Broad nouns and partial capability overlap cannot bypass existing Harness, risk, polarity, or relevance gates. Compact schema v4 carries the new stable reason codes without raw task or capability details. The public 28-case synthetic benchmark gates precision, recall, exact-set accuracy, bilingual parity, negative controls, context accounting, and determinism.
- Integration publication is one recoverable, lease-scoped transaction. It revalidates the claimed plan immediately before mutation, restores Hook and companion state after definite pre-finalize failures, persists uncertainty or failed compensation for recovery, and reports path-free structured receipts through every public surface.
- Dashboard integration cards now show action-specific create, upgrade, connect, unchanged, blocked, and disconnect states in English and Chinese. Apply, retry, and force controls are absent from blocked states.
- CLI, loopback API, and Dashboard disconnect plans now agree on `retained` versus `removed`, and final-uninstall receipts expose exact cleanup or recovery state instead of deferring an unspecified manual cleanup.
- Native publication validates the exact six-package set, platform metadata, four-file tarball shape, and registry SHA-512 integrity before publishing. A rerun skips only byte-identical versions and refuses mismatched or unverifiable registry state, so partial publication can resume safely. A protected, short-lived token path exists only to create the six package names once; later releases use npm trusted publishing through pinned, verified Node and npm clients.
- CLI publication now has a separate manual exact-main workflow and protected environment. It reuses the source-bound tarball verifier, requires all six matching native versions before registry access, safely resumes only a byte-identical CLI version, publishes with the contract tag and provenance, and gates promotion on clean Linux, macOS, and Windows registry installs. The workflow is present but no npm package is published by this repository change.
- Normal lease-waiter temporary entries no longer invalidate an active transaction's state-directory proof. Directory replacement is still detected by device, inode, type, and physical-path identity, while lease ownership and private state permissions remain independently enforced.
- Windows integration journals use exact directory identity and physical-containment revalidation without requesting unsupported directory `fsync`; POSIX journals retain the stricter directory-durability gate. Phase 4 integration mutation remains unavailable on Windows.
- Preflight delivery now survives optional report/evidence persistence failures after analysis. Compact schema v3 carries a stable warning and null feedback command when evidence was not saved, while the packaged companion expands continuation shorthand from the active task instead of submitting context-free words such as “continue”.
- Preflight algorithm v8 adds one versioned, corroborated lifecycle trigger for detailed pre-merge review tasks. The current profile requires the `request` + `code` + `review` name signature, positive `review ... before merge` task intent, and a positive `before merge` routing phrase; generic names and phrases split by Unicode punctuation/symbol boundaries cannot provide the signal. One bounded parser handles straight/curly English negations, negative lists, and explicit comma/colon contrasts. A `code` discriminator resolves mixed review objects without changing the positive trigger requirement. Capability-gap gating uses positive matches over the complete metadata denominator, so negative terms cannot strengthen corroboration. Existing safety exclusions and complementary-Skill selection still apply. Compact output moves to schema v3, remains bounded and task-free, nulls feedback when evidence persistence fails, and the CLI and bilingual dashboard render the new reason explicitly.
- Negative intent also wins when at least two candidate-name terms have stronger negative than positive coverage, preventing requesting and receiving review variants from bypassing an explicit code-review exclusion. Action-named colon lists joined by bounded words or Unicode punctuation/symbols remain negative, as do optional-comma `instead of` forms; a standalone `instead` marker still preserves a multi-action positive contrast.
- Lifecycle-fragment readers now retry ordinary concurrent cleanup when an identity mismatch is immediately followed by proven path absence, while a still-present same-name replacement continues to fail closed.

## [0.5.0-alpha.4] - 2026-07-04

### Added

- Core native inventory adapters inspect documented local direct and plugin Skill surfaces for Codex, Claude Code, and GitHub Copilot CLI. Reports and the dashboard separate source status, Harness coverage, and Skill exposure instead of treating directory presence as proof of availability.
- **Source statuses:** `scanned`, `missing`, `unreadable`, `invalid`, `disabled`, `stale`, `ambiguous`, `truncated`
- **Harness coverage:** `verified`, `partial`, `unavailable`, `convention-only`
- **Skill exposure:** `effective`, `shadowed`, `inactive`, `ambiguous`
- `skill-steward preflight --stdin --compact-json` provides a deterministic one-line Harness/Skill handoff of at most 4,096 UTF-8 bytes with selected use/install recommendations; companion Hook output remains capped at 2,048 bytes.

### Changed

- Preflight algorithm v7 and result schema v4 add recommendation-neutral, high-confidence capability-gap search hints with candidate relevance corroboration, a gap-only canonical namespace for task aliases and positive candidate coverage, exclusion of negative usage clauses from corroboration and coverage, canonical deduplication before the six-item bound, and a conservative no-credible-candidate fallback. Generic single-token names cannot corroborate a hint by exact name alone; specialized exact names and thresholded specific multi-concept evidence remain eligible. Shared routing retains its bounded Simplified/Traditional Chinese lexical behavior and does not recover low-confidence unsegmented two-character fragments.
- Reports and the dashboard preserve native source, ownership, plugin, and exposure records. Preflight consumes resolved visibility, excludes shadowed or inactive Skills, and expresses relevant outcomes through reason codes and inventory warnings.

### Safety and privacy

- Native plugin-managed Skills are read-only in Skill Steward governance and are refused before quarantine/restore plan or evidence persistence; directly managed Skills retain reviewed quarantine and restore.
- Compact Preflight omits raw task text, full candidate features, and readable reasons. Full `--json` returns the complete `PreflightResult`, including catalog `source` metadata for available catalog candidates, but does not embed native inventory ownership, plugin, source, or exposure records. Stored evidence remains privacy-reduced.

### Distribution

- The CLI version is `0.5.0-alpha.4`. The locked runtime audit records `jsonc-parser@3.3.1` under MIT and `smol-toml@1.7.0` under BSD-3-Clause; report-only development dependency `marked` is not part of the runtime audit.

### Limitations

- Native semantics are verified only for documented local Codex, Claude Code, and GitHub Copilot CLI surfaces. GitHub Copilot Harness coverage can remain `partial`; an affected source or Skill exposure can remain `ambiguous` when local proof is unavailable.
- A scan is a current-workspace snapshot plus user scopes, not a crawl of every project or workspace. Across the total 30 Harnesses, coverage outside the three core adapters remains `convention-only` directory inventory/install coverage where native semantics are not verified.
- This remains an active Alpha. Plugin management and Hook support stop at the documented adapters, routing remains lexical, and lifecycle evidence does not measure task success.

## [0.5.0-alpha.3] - 2026-07-03

### Added

- CLI installation, governance, integration apply, evidence-policy, and evidence-erasure now use exact, single-use reviewed plans that persist privately across processes and apply only through the emitted `--plan <id> --confirm` command.
- Catalog installation retains the inspected source in private staging until apply or expiry, then rechecks source, destination, route, provenance, and filesystem safety without restaging from the network.
- Managed integration apply persists an initial portfolio scan before reporting ready, rolls back safely on readiness failure, and serializes CLI and dashboard mutations through a private cross-process lease without consuming a waiting plan.
- Installation apply and rollback now share that state-scoped lease across CLI and dashboard processes. Apply acquires it before claiming a reviewed plan and revalidates the destination after copy, so concurrent replacements cannot both commit or corrupt backup provenance.
- Integration history uses private immutable journal fragments with bounded recovery and cleanup rather than concurrent rewrites of one shared record.
- Preflight evidence preserves normalized Harness and CLI/dashboard/Hook delivery attribution while continuing to exclude raw task content.

### Changed

- Preflight algorithm v4 routes Simplified- and Traditional-Chinese tasks with word-level concepts and filters generic workflow language, preventing unrelated Skills from matching through common single characters while preserving explainable deterministic scoring. Evidence uses a distinct numeric identity when the Node ICU/CLDR/Unicode segmentation runtime differs from the verified reference.
- The Evidence dashboard lifecycle badge now counts only lifecycle reasons, rather than all delivery and lifecycle events, so an empty lifecycle panel cannot display a contradictory non-zero total.

### Distribution

- The CLI package now ships a package README, MIT license, deterministic complete third-party notices, and complete repository metadata.
- CI and local package tests verify real npm and pnpm tarballs against the trusted package tree and source-controlled runtime audit, including exact files, manifest semantics, runtime bytes, license attribution, and hostile archive metadata.

### Security

- Reviewed plans use strict private envelopes, atomic single-use claim, bounded fail-safe cleanup, and domain fingerprint revalidation; a claimed plan that fails validation is not silently regenerated.
- Integration readiness, journal commit, compensation, and shared companion cleanup preserve original failures and report rollback-incomplete state when safe recovery cannot be proven.
- A busy installation remains retryable without consuming its waiting CLI plan; a stale waiter that later enters the lease is refused on destination drift.

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
