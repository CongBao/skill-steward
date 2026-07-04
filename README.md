# Skill Steward

English | [简体中文](README.zh-CN.md)

Know which Agent Skills you have, which ones a task needs, and change them safely.

Skill Steward is a local companion for Codex, Claude Code, GitHub Copilot, and other coding Harnesses. It is not a Harness: it does not answer prompts, run agents, or replace each product's own Skill and plugin system. It inventories the Skills on your machine, recommends a small set for the task in front of you, and puts review and recovery around changes.

> Status: active alpha. Install from source or a local tarball; the npm package is not published yet.

## Three jobs

### 1. Understand your Skill portfolio

Scan standard user and project Skill directories for 30 Harnesses, inspect complete bundles, and see duplicate content, broken references, oversized context, scripts, executables, portability problems, and scope overlap in one local dashboard.

### 2. Preflight the current task

Compare the task with both installed Skills and candidates from public catalogs you explicitly enabled. Results separate **Use now**, **Consider installing**, **Capability gaps**, and **Excluded**, so an uninstalled candidate is visible without being treated as already trusted.

### 3. Make reviewed, reversible changes

Inspect the source revision and exact filesystem plan before installation. Confirmed changes use provenance, backups, drift checks, and rollback. Quarantine and restore remove a Skill from active use without offering permanent deletion.

The ranking is deterministic and local; it does not require an LLM. Your Harness still decides whether and how to use a recommended Skill.

## Native inventory visibility

Finding a directory does not prove the Harness can use the Skill. Core native inventory adapters for Codex, Claude Code, and GitHub Copilot CLI inspect documented local direct and plugin Skill surfaces, then the report and UI show three separate kinds of state:

- **Source statuses:** `scanned`, `missing`, `unreadable`, `invalid`, `disabled`, `stale`, `ambiguous`, `truncated`
- **Harness coverage:** `verified`, `partial`, `unavailable`, `convention-only`
- **Skill exposure:** `effective`, `shadowed`, `inactive`, `ambiguous`

Copilot Harness coverage can remain `partial` when local runtime or MDM evidence is incomplete. An affected source or Skill exposure can remain `ambiguous` when local files do not prove activation or precedence.

Native plugin-managed Skills are read-only in Skill Steward governance; manage them through the owning Harness. Skill Steward quarantine and restore apply only to directly managed Skills. Across the total 30 Harnesses, coverage outside the three core adapters is convention-only directory inventory/install coverage where native semantics have not been verified.

A scan is a current-workspace snapshot plus user scopes; it does not crawl every project or workspace.

## Screenshots

These views use local example data to show populated states; the scores and evidence counts are not project usage results.

![Portfolio overview in English](docs/images/overview-light-en.png)

![Task Preflight with installed and available candidates](docs/images/preflight-discovery-light-en.png)

![Evidence dashboard with explicit feedback, lifecycle, Harness, and algorithm metrics](docs/images/evidence-light-en.png)

![Reviewed quarantine plan with verified recovery and no permanent delete](docs/images/governance-dark-en.png)

Screenshots in this README use the English locale. The [Chinese README](README.zh-CN.md) uses the matching Chinese captures.

## Installation

### Requirements

- Node.js 22 or newer
- pnpm 10 or newer for source development

### Run from source

```bash
git clone https://github.com/CongBao/skill-steward.git
cd skill-steward
pnpm install --frozen-lockfile
pnpm check
node packages/cli/dist/main.js dashboard
```

SSH works too:

```bash
git clone git@github.com:CongBao/skill-steward.git
```

Use `--no-open` to print the loopback URL without opening a browser:

```bash
node packages/cli/dist/main.js dashboard --no-open --port 4762
```

### Install a locally packed CLI

```bash
mkdir -p artifacts
pnpm --filter skill-steward pack --pack-destination artifacts
npm install --global ./artifacts/skill-steward-*.tgz
skill-steward dashboard
```

If an older global build is already installed, repack and reinstall it before testing repository changes. Check the active binary with `skill-steward --version`.

The packed CLI includes its package `README.md`, MIT `LICENSE`, generated `THIRD_PARTY_NOTICES.txt`, and a machine-readable third-party manifest. The artifact verifier checks real npm and pnpm tarballs against the trusted build tree and the source-controlled `runtime-audit.json`; normal builds fail rather than silently rewriting that audit.

## First use

The shortest useful path is one scan, one real task, and the dashboard:

```bash
skill-steward scan
skill-steward preflight \
  --task "Review this TypeScript change for security regressions and missing tests" \
  --harness codex
skill-steward dashboard
```

This first path is read-only. For installation, policy, or governance changes, stop at the preview and apply only the exact command it prints; no mutation is required to evaluate the portfolio or recommendations. Harness integration setup is review-only in the current alpha and does not emit an apply command.

For a headless inventory or report:

```bash
skill-steward doctor --json
skill-steward discover --json
skill-steward report --format markdown
```

State is stored in `~/.skill-steward`. Override that location without changing the Skill roots:

```bash
SKILL_STEWARD_HOME=/path/to/private/state skill-steward dashboard --no-open
```

## Task preflight

Task Preflight answers two questions before work starts:

1. Which installed Skills add distinct value now?
2. Which not-yet-installed Skills could fill a meaningful gap?

```bash
skill-steward preflight --task-file ./task.txt --max-skills 3
printf '%s' "Review this pull request" | skill-steward preflight --stdin --compact-json
skill-steward preflight --task "Review this pull request" --installed-only
```

Installed candidates rank ahead of otherwise similar catalog candidates. An available candidate is excluded when it is critically risky, incompatible with the target Harness, or duplicates installed content. Algorithm v8 and result schema v4 retain narrow English routing clauses, the two-term minimum for non-name matches, and deterministic bounded Simplified/Traditional Chinese concept canonicalization for long-session, evolving-requirements, and context-compaction intent. For detailed tasks, Algorithm v8 uses a versioned trigger profile: the current profile recognizes `review ... before merge` only for a `request` + `code` + `review` Skill-name signature whose positive routing description also contains `before merge`. Generic name words do not qualify, and phrase matching never crosses Unicode punctuation or symbol boundaries. One internal bounded parser recognizes task negations `do not`, straight/curly `don't`, `never`, `avoid`, and `without`, plus candidate routing negations built from use/invoke/call/run/apply actions. Negated clauses stop at semicolons, sentence punctuation, or line breaks; comma/colon lists and punctuation-rich technical terms stay negative, while an explicit `, but ...` or colon followed by a positive action opens a positive contrast. Recognized negated task text contributes neither ordinary relevance, full-name matching, trigger evidence, nor capability gaps. The current lifecycle rule uses `code` only to resolve mixed positive/negative objects: negated code review still vetoes positive documentation review, while independently positive code review remains eligible beside negated documentation review. Critical risk or Harness ineligibility still excludes the candidate. Capability gaps are high-confidence Skill search hints: candidate metadata must pass either a name match that contributes a specific capability concept or the minimum specific multi-term relevance gate; generic single-token names do not corroborate a hint by name alone. Concise tasks without credible candidates use a conservative non-generic fallback. Gap-only projection puts positive task aliases, positive candidate metadata, and selected positive coverage in one canonical namespace; its relevance gate uses positive matches over the complete metadata denominator, so negative text can never strengthen corroboration. Canonical deduplication happens before the six-hint bound. Unsegmented two-character fragments made only of generic Han characters are low confidence and create neither routing/name matches nor standalone gaps. These display rules do not alter recommendation scoring. This is still lexical routing, not general cross-language semantic understanding. Results include relevance, unique coverage, risk, redundancy, context estimates, source revision, compatibility, and readable reasons.

An explicit code-review rejection also keeps both requesting and receiving code-review variants out of the recommendation. Action-name lists after a colon stay negative rather than opening a positive contrast.

Use `--compact-json` for Harness or companion-Skill handoff. Compact schema v3 emits one line and at most 4,096 UTF-8 bytes, with selected use/install recommendations and stable warning codes but no raw task. Its feedback command is `null` when evidence persistence failed. `--json` returns the complete `PreflightResult`: candidate decisions, scores, features, reasons, conflicts, inventory warnings, capability gaps, and aggregate coverage. Available catalog candidates may include catalog `source` metadata. It does not embed native inventory source, ownership, plugin, or exposure records. The portfolio reports and dashboard preserve those records; Preflight consumes resolved visibility and expresses relevant outcomes through candidate reason codes and inventory warnings. Companion Hooks remain capped at 2,048 bytes.

If the private state directory is readable but cannot be written by the current Harness sandbox, Preflight still returns the recommendation with exit code zero. It emits `PREFLIGHT_PERSISTENCE_UNAVAILABLE`, does not expose the failed path, and makes clear that this run cannot accept feedback because its report and evidence were not saved.

Human CLI output includes the Preflight run ID and, when the run was saved, a direct feedback command. Full candidate and reason details remain available with `--json`.

```bash
skill-steward evidence feedback --preflight <run-id> --label useful
skill-steward evidence feedback \
  --preflight <run-id> \
  --label incomplete \
  --candidate <complete-correct-candidate-set>
```

For `incomplete`, `--candidate` is the complete set that should have been recommended, including any original recommendations that were already correct. This keeps correction metrics meaningful.

The raw task text is never written to disk. Stored evidence contains only allow-listed hashes, IDs, aggregate counts, numeric scores, source IDs, and optional feedback.

### Opt-in discovery sources

All built-in sources start disabled:

- [OpenAI Plugins](https://github.com/openai/plugins), scanning Skills nested in public plugin bundles;
- [Anthropic Skills](https://github.com/anthropics/skills);
- [Awesome GitHub Copilot](https://github.com/github/awesome-copilot), classified as a community source.

Enable and refresh sources explicitly:

```bash
skill-steward catalog enable openai-plugins
skill-steward catalog refresh
skill-steward catalog list --json
```

Custom sources must be credential-free public HTTPS Git repositories. Adding a source leaves it disabled. Refresh is the only networked indexing step; Hooks and Preflight use the validated local cache with no prompt-time network access. “Known publisher” describes repository ownership, not safety.

## Evidence and data policy

The **minimal mode is the default**. It retains privacy-reduced Preflight metadata and explicit `useful`, `incomplete`, or `incorrect` feedback, but no lifecycle correlation keys or ranking feature snapshots.

Learning mode is opt-in. It adds bounded numeric feature snapshots and content-free Hook events with HMAC-SHA256 pseudonyms. A private per-install salt is stored with mode `0600` and is never included in export, API responses, or the dashboard. Prompts, extracted terms, working-directory paths, raw session/turn IDs, transcripts, assistant messages, tool arguments, and tool output are excluded.

```bash
skill-steward evidence policy --json
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000
skill-steward evidence policy set --plan <id> --confirm
skill-steward evidence summary --json
skill-steward evidence export --output ./skill-steward-evidence.json
skill-steward evidence compact
skill-steward evidence erase
skill-steward evidence erase --plan <id> --confirm
```

The request without `--confirm` creates an exact, expiring plan. Apply only with the emitted ID: `--plan <id> --confirm` loads that same plan in a later process instead of rebuilding it from new arguments. Plans are single-use; a claimed plan that encounters drift or another apply-time failure is consumed, and the CLI asks for a fresh preview. Retention is configurable from 7 to 365 days and lifecycle storage from 100 to 10,000 events.

The Evidence dashboard shows the numerator and denominator for feedback rate, useful/incomplete/incorrect labels, corrected-set precision/recall/F1, and provenance-only install conversion. It separates lifecycle reasons from explicit labels and compares Harnesses, algorithm versions, and rolling 7/30-day windows. **Lifecycle completion is not task success.** Calibration review requires at least **100 labeled preflights**, 30 corrected candidate sets, and 20 portfolio fingerprints. **No ranking threshold or weight changes automatically**; calibration would require a separate reviewed release.

## Harness integration

The current alpha can inspect Codex, Claude Code, and GitHub Copilot CLI integration state and create an exact reviewed plan. JSON status keeps the Harness Hook and the shared companion Skill separate, so an installed Hook cannot hide a missing, outdated, modified, or unreadable companion:

```bash
skill-steward integrate status --json
skill-steward integrate plan --harness codex
skill-steward integrate plan --harness claude-code
skill-steward integrate plan --harness github-copilot
```

Each preview persists the exact configuration, backup paths, companion tree, packaged source, and ownership proof. Apply claims the single-use plan under the shared mutation lease and revalidates those fields plus the current Harness configuration, record head, and consumer set.

**Lifecycle apply is intentionally disabled in this alpha.** Even a current plan is rejected before any Hook or companion write. Transaction-safe companion create/upgrade, readiness rollback, and shared-consumer removal are the next implementation phase. The CLI still accepts the apply command so the fail-closed contract can be tested, but it is not an installation path yet.

For users who installed a managed Hook with an earlier Alpha, `skill-steward integrate remove --harness <id> --confirm` remains a narrow cleanup path. It removes only the provably managed Hook entry and retains the shared companion Skill; consumer-aware companion removal is not enabled yet. This cleanup command is not part of new integration setup.

Once enabled, the managed Hooks fail open and use cached local state. The implemented Codex and Claude Code adapters cover `UserPromptSubmit` and completion Hooks. Both receive a compact recommendation, not raw task text or catalog URLs. Codex may require its native trust review. The GitHub Copilot CLI adapter is intentionally observe-only: its documented Hook receives lifecycle events, while recommendations remain available through the companion Skill or explicit CLI Preflight.

## Harness capability matrix

| Harness | Managed events | Recommendation | Local evidence |
|---|---|---|---|
| Codex | `UserPromptSubmit`, `Stop` | Recommend + observe through the prompt Hook | Turn lifecycle |
| Claude Code | `UserPromptSubmit`, `Stop`, `SessionEnd` | Recommend + observe through the prompt Hook | Turn and session lifecycle |
| GitHub Copilot CLI | `userPromptSubmitted`, `sessionEnd` | **Observe only**; recommendations via companion Skill/CLI | Prompt observation and session lifecycle |

All three adapter configurations are tested with temporary-HOME fixtures and preserve unrelated configuration. Public lifecycle apply remains disabled as described above. “Observe only” is deliberate: the Copilot adapter does not inject recommendations into prompts.

## Supported harnesses

The root catalog covers 30 Harnesses: Amazon Q, Antigravity, Auggie, Bob, Claude Code, Cline, CodeBuddy, Codex, ForgeCode, Continue, CoStrict, Crush, Cursor, Factory, Gemini CLI, GitHub Copilot, iFlow, Junie, Kilo Code, Kimi, Kiro, Lingma, Vibe, OpenCode, Pi, Qoder, Qwen Code, RooCode, Trae, and Windsurf.

Across the total 30 Harnesses, coverage outside the three core adapters provides convention-only directory inventory and installation. Native workflow integration is narrower still and is described exactly in the capability matrix.

## How safe installation works

Skill Steward never installs a recommendation automatically. A catalog recommendation follows the same reviewed flow as a folder, ZIP, or public Git source:

1. **Inspect** — resolve the recorded commit and recheck fingerprint, files, scripts, executables, references, and findings.
2. **Choose destination** — select Harness, global/project scope, workspace, and target name.
3. **Resolve conflicts** — identical content is a no-op; different content requires a rename or explicit replacement.
4. **Confirm** — review the exact filesystem operations.
5. **Apply** — create or replace atomically, record provenance, and rescan the portfolio.
6. **Rollback** — restore the backup only while destination drift checks still pass.

For a catalog candidate, preview first and then run the exact command it prints:

```bash
skill-steward install --catalog-candidate <candidate-id> --harness codex --scope global
skill-steward install --plan <id> --confirm
```

The preview keeps the inspected source in private staging until the plan is applied or expires. Apply reuses that staged content in a later process, checks source and destination fingerprints again, and never restages from the network behind the reviewed plan.

Installation apply and rollback share one state-scoped cross-process lease with managed Harness changes. The CLI acquires it before consuming the reviewed plan and checks the destination again after preparing the verified copy. Concurrent replacements therefore serialize: a stale waiter stops on drift instead of overwriting the newer installation or recording the wrong backup.

ZIP traversal, absolute paths, links, case-folding collisions, excessive entries, and expansion limits are rejected. Git staging is non-interactive, disables repository Hooks and submodules, and never executes source content.

## Reversible governance

Quarantine removes an installed Skill from active discovery without deleting it permanently. It creates and verifies a private copy, moves the active directory atomically through a rollback location, commits the vault copy, and records the transaction. Restore verifies the vault again and refuses an occupied destination, an expired plan, or source/destination drift.

```bash
skill-steward govern history --json
skill-steward govern quarantine --skill <skill-id>
skill-steward govern quarantine --plan <id> --confirm
skill-steward govern restore --transaction <quarantine-id>
skill-steward govern restore --plan <id> --confirm
```

The dashboard exposes the same operation plan. There is no Delete action. Recovery keeps at least one verified copy if a transaction fails at copy, verification, move, vault, journal, or restore boundaries.

## Comparison

Codex, Claude Code, and GitHub Copilot already own the execution environment and their native Skill/plugin experience. Skill Steward complements them with a local inventory, task-specific comparison, and reviewed recovery flow that spans their known Skill directories.

| Product | External task-time discovery | Native workflow integration | Cross-Harness analysis | Reversible installation |
|---|---|---|---|---|
| **Skill Steward** | Opt-in cached public Git indexes; installed and available candidates ranked together | Proof-aware status and reviewed adapter plans; public Hook/companion apply not enabled yet | **One inventory, scoring, evidence, and governance model across 30 root conventions** | **Cross-process exact plans, persistent staging, drift refusal, install/rollback, and verified quarantine/restore** |
| [Codex Skills and Plugins](https://developers.openai.com/codex/plugins) | Plugin directory and marketplace browsing; install before use | Native Skills, plugins, and lifecycle Hooks | Codex scope | Native enable/disable/uninstall; no Skill Steward journal |
| [Claude Code Skills and Plugins](https://code.claude.com/docs/en/discover-plugins) | Marketplaces separate catalog registration from plugin installation | Native Skills, plugins, marketplaces, and Hooks | Claude Code scope | Native plugin update/removal; no Skill Steward journal |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | `gh skill` can discover and install Skills from GitHub repositories | Native Skills and Hooks in Copilot CLI/cloud agent | Copilot-compatible scopes | Native Skill management; no Skill Steward journal |

## Privacy and security

- The server binds to `127.0.0.1` and rejects unexpected Host and Origin values.
- Packaged UI assets are same-origin and load no remote fonts, scripts, images, or analytics.
- Mutations require a random per-process token held by the local page.
- Dashboard read APIs do not return complete Skill bodies.
- Prompt-time Preflight uses cached state and does not contact catalog sources.
- Minimal evidence is the default; learning mode requires a reviewed policy change.
- Persisted evidence excludes task text, extracted terms, descriptions, reasons, URLs, local paths, transcripts, assistant content, tool data, and raw Harness IDs.
- Sanitized export and API responses never include the private HMAC salt.
- Installation-source scripts, package managers, build commands, repository Hooks, and submodules are not executed.
- CLI installation, integration apply, evidence-policy, evidence-erasure, quarantine, and restore plans are persisted privately, expire, and are single-use; confirmation never regenerates a plan from request arguments.
- Installation apply/rollback uses a cross-process mutation lease. Public integration apply currently revalidates its claimed plan under the integration lease and then refuses before any Hook or companion write; the transaction-safe mutation path is not enabled yet.
- Packed npm and pnpm tarballs are checked against the exact local package tree, generated notices, and the locked runtime audit.
- Governance offers verified quarantine/restore, not permanent deletion, and stops on drift.

Review [SECURITY.md](SECURITY.md) before reporting a vulnerability. Package boundaries and trust decisions are documented in [docs/architecture.md](docs/architecture.md).

## Current limitations

- Task scoring is a deterministic lexical baseline. Algorithm v8 adds one bounded, corroborated lifecycle-trigger signal alongside limited Simplified/Traditional Chinese concepts and high-confidence capability-gap hints; it does not provide general cross-language semantic understanding or measure actual task success.
- Evidence describes recommendations and lifecycle events; it does not prove task success or change ranking automatically.
- Harness integration can produce proof-aware plans and separate Hook/companion status, but public lifecycle apply is intentionally disabled until the transaction-safe companion phase lands.
- GitHub Copilot CLI is observe-only; prompt-time recommendation injection is not supported.
- Native inventory is limited to documented local surfaces for Codex, Claude Code, and GitHub Copilot CLI. Copilot Harness coverage can remain `partial` when local runtime or MDM proof is unavailable; an affected source or Skill exposure can remain `ambiguous`.
- Each scan covers the current workspace and user scopes, not every project or workspace on the machine.
- Across the total 30 Harnesses, coverage outside the three core adapters follows directory conventions; inventory support for a Harness does not imply verified native plugin or Hook semantics.
- Native plugin-managed Skills are reported but read-only in governance. Manage them through their owning Harness; Skill Steward quarantine and restore remain direct-Skill operations.
- A reviewed plan is intentionally consumed after it is claimed, including when later validation detects drift; create a new preview before retrying.
- Skill Steward protects against detected filesystem drift and unsafe paths, but it is not an isolation boundary from another malicious process running as the same operating-system user.
- Catalog refresh supports public credential-free HTTPS Git sources, not private repositories or SSH.
- Catalog records are metadata snapshots, not endorsements. Source contents are reinspected before an install plan.
- Finding explanations remain English when the dashboard locale is Chinese.

## Roadmap

1. Validate additional native adapters only where local precedence, activation, lifecycle, and trust behavior can be tested.
2. Evaluate reviewed ranking calibration only after the published evidence thresholds are met.
3. Add scope migration and broader policy baselines on top of the reversible governance journal.
4. Add signed release artifacts and supply-chain attestations.

See [CHANGELOG.md](CHANGELOG.md) for released behavior and the [2026-07-03 product review](docs/product-review-2026-07-03.md) for the historical Alpha.3 verdict, hands-on evidence, baseline, and priorities.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). For help use [SUPPORT.md](SUPPORT.md); for vulnerabilities use [SECURITY.md](SECURITY.md). The project is available under the [MIT License](LICENSE).
