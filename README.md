# Skill Steward

English | [简体中文](README.zh-CN.md)

A local-first, cross-Harness control plane for Agent Skills. Skill Steward integrates with Codex, Claude Code, GitHub Copilot, and other harnesses; it does not replace them or run coding tasks itself.

> Status: active alpha. Install from source or a local tarball; the npm package is not published yet.

## Why Skill Steward

Codex, Claude Code, and GitHub Copilot now have capable Skill and plugin ecosystems of their own. The remaining problem is what happens across them: duplicated local Skills, unclear scope, conflicting triggers, expensive context, and task-specific capabilities scattered across several catalogs.

Skill Steward provides one local decision layer:

- inventories standard user and project Skill directories for 30 harnesses;
- audits complete bundles for structure, references, portability, size, overlap, scripts, and executable files;
- indexes opt-in public sources so Task Preflight can compare installed Skills with Skills you have not installed;
- separates results into **Use now**, **Consider installing**, **Capability gaps**, and **Excluded**;
- connects to Codex and Claude Code `UserPromptSubmit` and completion Hooks, and observes the documented GitHub Copilot CLI lifecycle without claiming prompt injection;
- inspects every recommendation again at its recorded revision before showing an installation plan;
- applies confirmed changes with backups, provenance, drift checks, and rollback;
- measures local recommendation quality with explicit labels, correction metrics, install provenance, Harness/algorithm breakdowns, and privacy-safe lifecycle signals;
- quarantines and restores Skills through verified, drift-protected transactions instead of permanent deletion;
- exposes the same services through CLI, loopback API, Hook, companion Skill, and dashboard.

The analysis is deterministic and does not require an LLM. The selected Harness still decides how to use a Skill and performs the actual work.

## Screenshots

![Task Preflight with installed and available Skills](docs/images/preflight-discovery-light-en.png)

![Codex and Claude Code integration settings](docs/images/integrations-dark-en.png)

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
pnpm build
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

## Quick start

Run the local dashboard:

```bash
skill-steward dashboard
```

Or use the headless workflow:

```bash
skill-steward doctor --json
skill-steward discover --json
skill-steward scan
skill-steward catalog list
skill-steward preflight --task "Review this TypeScript change for security regressions and missing tests" --harness codex
skill-steward report --format markdown
```

State is stored in `~/.skill-steward`. Override that location without changing the Skill roots:

```bash
SKILL_STEWARD_HOME=/path/to/private/state skill-steward dashboard --no-open
```

## Task preflight

Task Preflight answers two questions before a Harness starts work:

1. Which installed Skills add distinct value now?
2. Which not-yet-installed Skills could close a meaningful capability gap?

```bash
skill-steward preflight \
  --task "Review this pull request for security regressions and missing tests" \
  --harness codex

skill-steward preflight --task-file ./task.txt --max-skills 3
printf '%s' "Review this pull request" | skill-steward preflight --stdin --json
skill-steward preflight --task "Review this pull request" --installed-only
```

Installed candidates are ranked first. Available candidates receive an installation penalty and cannot be recommended when they are critically risky, incompatible with the target Harness, or duplicates of installed content. Results include relevance, unique coverage, risk, redundancy, context estimates, source revision, compatibility, and machine-readable reasons.

The raw task text is never written to disk. Stored evidence contains only hashes, IDs, aggregate counts, numeric scores, source IDs, and optional feedback.

## Evidence and data policy

Skill Steward can measure whether Preflight recommendations remain useful across real local work without storing the task itself. The **minimal mode is the default**: it retains privacy-reduced preflight metadata and explicit `useful`, `incomplete`, or `incorrect` feedback, but no lifecycle correlation keys or ranking feature snapshots.

Learning mode is an explicit opt-in. It adds bounded numeric feature snapshots and content-free Hook events with HMAC-SHA256 pseudonyms. A private per-install salt is stored with mode `0600` and is never included in export, API responses, or the dashboard. Prompts, extracted terms, working-directory paths, raw session/turn IDs, transcripts, assistant messages, tool arguments, and tool output are excluded.

```bash
skill-steward evidence policy --json
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000
skill-steward evidence policy set --mode learning --retention-days 30 --max-events 5000 --confirm
skill-steward evidence summary --json
skill-steward evidence export --output ./skill-steward-evidence.json
skill-steward evidence compact
skill-steward evidence erase
skill-steward evidence erase --confirm
```

Policy changes and erasure show an exact, expiring plan before mutation. Retention is configurable from 7 to 365 days and lifecycle storage from 100 to 10,000 events.

The Evidence dashboard reports numerator and denominator for feedback rate, useful/incomplete/incorrect labels, corrected-set precision/recall/F1, and provenance-only install conversion. It also separates lifecycle reasons from explicit labels and compares Harnesses, algorithm versions, and rolling 7/30-day windows. **Lifecycle completion is not task success.** Calibration review requires at least **100 labeled preflights**, 30 corrected candidate sets, and 20 portfolio fingerprints. **No ranking threshold or weight changes automatically**; any future calibration requires a separate reviewed release.

### Opt-in discovery sources

All built-in sources start disabled:

- [OpenAI Plugins](https://github.com/openai/plugins), scanning Skills nested in plugin bundles;
- [Anthropic Skills](https://github.com/anthropics/skills);
- [Awesome GitHub Copilot](https://github.com/github/awesome-copilot), classified as a community source.

Enable and refresh sources explicitly:

```bash
skill-steward catalog enable openai-plugins
skill-steward catalog refresh
skill-steward catalog list --json
```

Custom sources must be credential-free public HTTPS Git repositories. Adding a source leaves it disabled. Refresh is the only networked indexing step; Hook and preflight runs use the validated local cache with no prompt-time network access. “Known publisher” describes repository ownership, not safety.

## Harness integration

Skill Steward manages reviewed native Hook configuration for Codex, Claude Code, and GitHub Copilot CLI:

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex
skill-steward integrate apply --harness codex --confirm

skill-steward integrate plan --harness claude-code
skill-steward integrate apply --harness claude-code --confirm

skill-steward integrate plan --harness github-copilot
skill-steward integrate apply --harness github-copilot --confirm
```

The plan shows the exact configuration and backup paths before writing. Existing unrelated settings and Hooks are preserved. Removal refuses to overwrite externally changed configuration:

```bash
skill-steward integrate remove --harness codex --confirm
```

The managed Hooks are fail-open and read cached local state. Codex and Claude Code inject a compact recommendation, not raw task text or catalog URLs. Codex may require review and trust for the installed Hook. GitHub Copilot CLI is intentionally observe-only: its documented Hook receives lifecycle events, while recommendations remain available through the shared companion Skill or explicit CLI preflight.

## Harness capability matrix

| Harness | Managed events | Recommendation | Local evidence |
|---|---|---|---|
| Codex | `UserPromptSubmit`, `Stop` | Recommend + observe through the prompt Hook | Turn lifecycle |
| Claude Code | `UserPromptSubmit`, `Stop`, `SessionEnd` | Recommend + observe through the prompt Hook | Turn and session lifecycle |
| GitHub Copilot CLI | `userPromptSubmitted`, `sessionEnd` | **Observe only**; recommendations via companion Skill/CLI | Prompt observation and session lifecycle |

All three adapters use temporary-HOME fixtures and preserve unrelated configuration. “Observe only” is deliberate: this release does not inject recommendations into Copilot prompts.

## Supported harnesses

The root catalog covers 30 harnesses: Amazon Q, Antigravity, Auggie, Bob, Claude Code, Cline, CodeBuddy, Codex, ForgeCode, Continue, CoStrict, Crush, Cursor, Factory, Gemini CLI, GitHub Copilot, iFlow, Junie, Kilo Code, Kimi, Kiro, Lingma, Vibe, OpenCode, Pi, Qoder, Qwen Code, RooCode, Trae, and Windsurf.

This means Skill Steward can inventory and install to their known directories. Native workflow integration is deliberately narrower and is described exactly in the capability matrix above.

## How safe installation works

Skill Steward never installs a recommendation automatically. A catalog recommendation must pass the same reviewed flow as a manually supplied folder, ZIP, or public Git source:

1. **Inspect** — resolve the recorded commit and recheck fingerprint, files, scripts, executables, references, and findings.
2. **Destination** — choose the Harness, global/project scope, workspace, and target name.
3. **Conflicts** — identical content is a no-op; different content stops for rename or explicit replacement.
4. **Confirm** — review exact filesystem operations and acknowledge them.
5. **Commit** — create or replace atomically, write provenance, and rescan the portfolio.
6. **Rollback** — restore the backup only if destination drift checks still pass.

ZIP traversal, absolute paths, links, case-folding collisions, excessive entries, and expansion limits are rejected. Git staging is non-interactive, disables repository Hooks and submodules, and never executes source content.

## Reversible governance

An installed Skill can be removed from active discovery without permanent deletion. Quarantine first creates a private copy, verifies its fingerprint, atomically moves the active directory through a rollback location, commits the vault copy, and records the transaction. Restore verifies the vault again and refuses an occupied destination, an expired plan, or any source/destination drift.

```bash
skill-steward govern history --json
skill-steward govern quarantine --skill <skill-id>
skill-steward govern quarantine --skill <skill-id> --confirm
skill-steward govern restore --transaction <quarantine-id>
skill-steward govern restore --transaction <quarantine-id> --confirm
```

The dashboard exposes the same exact operation plan. There is no Delete action. If a transaction fails at copy, verification, move, vault, journal, or restore boundaries, recovery preserves at least one verified copy and records the failed boundary for diagnosis.

## Comparison

Each major Harness already has its own Skill and extension system. Skill Steward focuses on the local policy, evidence, and recovery layer that spans them:

| Product | External task-time discovery | Native workflow integration | Cross-Harness analysis | Reversible installation |
|---|---|---|---|---|
| **Skill Steward** | Opt-in cached public Git indexes; installed and available candidates ranked together | Codex/Claude recommend+observe; Copilot observe-only; companion Skill, CLI, API, dashboard | **One inventory, scoring, evidence, and governance model across 30 root conventions** | **Reviewed install/rollback plus verified quarantine/restore** |
| [Codex Skills and Plugins](https://developers.openai.com/codex/plugins) | Plugin directory and marketplace browsing; install before use | Native Skills, plugins, and lifecycle Hooks | Codex scope | Native enable/disable/uninstall; no Skill Steward cross-Harness journal |
| [Claude Code Skills and Plugins](https://code.claude.com/docs/en/discover-plugins) | Plugin marketplaces separate catalog registration from chosen plugin installation | Native Skills, plugins, marketplaces, and Hooks | Claude Code scope | Native plugin update/removal; no Skill Steward cross-Harness journal |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | `gh skill` can discover and install Skills from GitHub repositories | Native Skills and Hooks in Copilot CLI/cloud agent | Copilot-compatible scopes | Native Skill management; no Skill Steward cross-Harness journal |

## Privacy and security

- The server binds to `127.0.0.1` and rejects unexpected Host and Origin values.
- Packaged UI assets are same-origin and load no remote fonts, scripts, images, or analytics.
- Mutations require a random per-process token held by the local page.
- Dashboard read APIs do not return complete Skill bodies.
- Prompt-time preflight uses cached state and does not contact catalog sources.
- Minimal evidence is the default; learning mode requires a reviewed policy change.
- Persisted evidence excludes task text, extracted terms, descriptions, reasons, URLs, local paths, transcripts, assistant content, tool data, and raw Harness IDs.
- Sanitized export and API responses never include the private HMAC salt.
- Installation-source scripts, package managers, build commands, repository Hooks, and submodules are not executed.
- Governance offers verified quarantine/restore, not permanent deletion, and stops on drift.

Review [SECURITY.md](SECURITY.md) before reporting a vulnerability. Package boundaries and trust decisions are documented in [docs/architecture.md](docs/architecture.md).

## Current limitations

- Task scoring is a deterministic lexical baseline; no LLM is used and actual task success is not yet measured.
- Evidence describes recommendations and lifecycle events; it does not prove task success or alter ranking automatically.
- GitHub Copilot CLI is observe-only; prompt-time recommendation injection is not supported.
- Catalog refresh supports public credential-free HTTPS Git sources, not private repositories or SSH.
- Catalog records are metadata snapshots, not endorsements. Source contents can change and are always reinspected before planning an install.
- Finding explanations remain English even when the dashboard locale is Chinese.

## Roadmap

1. Evaluate reviewed ranking calibration only after the published evidence thresholds are met.
2. Add scope migration and broader policy baselines on top of the reversible governance journal.
3. Add more native Harness adapters only where their lifecycle and trust model can be tested safely.
4. Add signed release artifacts and supply-chain attestations.

See [CHANGELOG.md](CHANGELOG.md) for released behavior.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). For help use [SUPPORT.md](SUPPORT.md); for vulnerabilities use [SECURITY.md](SECURITY.md). The project is available under the [MIT License](LICENSE).
