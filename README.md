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
- connects to Codex and Claude Code `UserPromptSubmit` Hooks, with a shared companion Skill and CLI as fallback surfaces;
- inspects every recommendation again at its recorded revision before showing an installation plan;
- applies confirmed changes with backups, provenance, drift checks, and rollback;
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

Skill Steward currently manages native prompt Hooks for Codex and Claude Code:

```bash
skill-steward integrate status
skill-steward integrate plan --harness codex
skill-steward integrate apply --harness codex --confirm

skill-steward integrate plan --harness claude-code
skill-steward integrate apply --harness claude-code --confirm
```

The plan shows the exact configuration and backup paths before writing. Existing unrelated settings and Hooks are preserved. Removal refuses to overwrite externally changed configuration:

```bash
skill-steward integrate remove --harness codex --confirm
```

The managed Hook is fail-open and reads cached local state. It injects a compact recommendation, not raw task text or catalog URLs. Codex may require review and trust for the installed Hook. GitHub Copilot roots are scanned and can see the shared companion Skill, but native Copilot prompt-Hook configuration is not implemented in this release.

## Supported harnesses

The root catalog covers 30 harnesses: Amazon Q, Antigravity, Auggie, Bob, Claude Code, Cline, CodeBuddy, Codex, ForgeCode, Continue, CoStrict, Crush, Cursor, Factory, Gemini CLI, GitHub Copilot, iFlow, Junie, Kilo Code, Kimi, Kiro, Lingma, Vibe, OpenCode, Pi, Qoder, Qwen Code, RooCode, Trae, and Windsurf.

This means Skill Steward can inventory and install to their known directories. Native task-submission integration is currently narrower: Codex and Claude Code Hooks, plus the shared companion Skill and CLI.

## How safe installation works

Skill Steward never installs a recommendation automatically. A catalog recommendation must pass the same reviewed flow as a manually supplied folder, ZIP, or public Git source:

1. **Inspect** — resolve the recorded commit and recheck fingerprint, files, scripts, executables, references, and findings.
2. **Destination** — choose the Harness, global/project scope, workspace, and target name.
3. **Conflicts** — identical content is a no-op; different content stops for rename or explicit replacement.
4. **Confirm** — review exact filesystem operations and acknowledge them.
5. **Commit** — create or replace atomically, write provenance, and rescan the portfolio.
6. **Rollback** — restore the backup only if destination drift checks still pass.

ZIP traversal, absolute paths, links, case-folding collisions, excessive entries, and expansion limits are rejected. Git staging is non-interactive, disables repository Hooks and submodules, and never executes source content.

## Comparison

Official documentation reviewed on 2026-07-03 shows that each major Harness already supports Skills and has its own discovery or extension system. Skill Steward competes at the cross-Harness policy and evidence layer:

| Product | External task-time discovery | Native workflow integration | Cross-Harness analysis | Reversible installation |
|---|---|---|---|---|
| **Skill Steward** | Opt-in cached public Git indexes; installed and available candidates ranked together | Codex and Claude Code prompt Hooks; companion Skill, CLI, API, and dashboard | **One inventory and scoring model across 30 root conventions** | **Reviewed plans, backups, provenance, drift checks, rollback** |
| [Codex Skills and Plugins](https://developers.openai.com/codex/plugins) | Plugin directory and marketplace browsing; install before use | Native Skills, plugins, and lifecycle Hooks | Codex scope | Native enable/disable/uninstall; no Skill Steward cross-Harness journal |
| [Claude Code Skills and Plugins](https://code.claude.com/docs/en/discover-plugins) | Plugin marketplaces separate catalog registration from chosen plugin installation | Native Skills, plugins, marketplaces, and Hooks | Claude Code scope | Native plugin update/removal; no Skill Steward cross-Harness journal |
| [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | `gh skill` can discover and install Skills from GitHub repositories | Native Skills and Hooks in Copilot CLI/cloud agent | Copilot-compatible scopes | Native Skill management; no Skill Steward cross-Harness journal |

## Privacy and security

- The server binds to `127.0.0.1` and rejects unexpected Host and Origin values.
- Packaged UI assets are same-origin and load no remote fonts, scripts, images, or analytics.
- Mutations require a random per-process token held by the local page.
- Dashboard read APIs do not return complete Skill bodies.
- Prompt-time preflight uses cached state and does not contact catalog sources.
- Persisted evidence excludes task text, extracted terms, descriptions, reasons, URLs, and local paths.
- Installation-source scripts, package managers, build commands, repository Hooks, and submodules are not executed.

Review [SECURITY.md](SECURITY.md) before reporting a vulnerability. Package boundaries and trust decisions are documented in [docs/architecture.md](docs/architecture.md).

## Current limitations

- Task scoring is a deterministic lexical baseline; no LLM is used and actual task success is not yet measured.
- Managed native prompt Hooks are available only for Codex and Claude Code.
- Catalog refresh supports public credential-free HTTPS Git sources, not private repositories or SSH.
- Catalog records are metadata snapshots, not endorsements. Source contents can change and are always reinspected before planning an install.
- Finding explanations remain English even when the dashboard locale is Chinese.

## Roadmap

1. Learn from local invocation and outcome signals without retaining raw prompts.
2. Add reviewed disable, quarantine, scope migration, uninstall, and restore actions.
3. Add more native Harness adapters only where their lifecycle and trust model can be tested safely.
4. Add signed release artifacts, policy baselines, and supply-chain attestations.

See [CHANGELOG.md](CHANGELOG.md) for released behavior.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). For help use [SUPPORT.md](SUPPORT.md); for vulnerabilities use [SECURITY.md](SECURITY.md). The project is available under the [MIT License](LICENSE).
