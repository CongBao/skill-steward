# Product Review — 2026-07-03

Alpha.3 verification completed on **2026-07-04 CST**; the document retains its original review date so existing public links remain stable.

## Current stage verdict — 0.5.0-alpha.3

The Alpha.3 build is ready for continued public Alpha use and for daily dogfooding across its implemented scope. It is easy to understand after the new three-job introduction, produces useful first value from one scan, connects its recommendation flow to real Harness prompts, and puts unusually strong review, drift refusal, recovery, and privacy boundaries around local changes. It is worth keeping installed for portfolio review, explicit task Preflight, catalog discovery, and reversible Skill governance.

The current product score is **8.5/10 under the expanded Alpha.3 qualitative rubric below**. The Alpha.2 post-fix score of **7.9/10** later in this document uses a different weighted rubric and is retained as historical evidence, not as a directly comparable numeric baseline. Alpha.3 adds persistent exact action plans, first-Hook readiness, real Harness/delivery evidence attribution, recommendation-to-install conversion, package-license completeness, responsive KPI configuration, and closes two defects found during installed-artifact dogfooding. The remaining ceiling is semantic task routing and native plugin inventory coverage, not the trust mechanics around the actions already supported.

This verdict does not claim Beta completion. The next competitive phase is native plugin/Skill inventory coverage and visible coverage accounting, followed by a broader labeled recommendation corpus. Skill Steward should remain a Harness companion rather than becoming a prompt-running Harness itself.

## Alpha.3 scope and evidence

The stage review used commit `ec65f4e` and the exact verified package `skill-steward-0.5.0-alpha.3.tgz` with SHA-256 `093c490271c0545404aa770352b8ff96e231da12ed82da94e2df2242db4900e9`. The tarball contained 11 expected package files and complete notices for 73 runtime packages, was installed globally, and reported `0.5.0-alpha.3` from `$HOME/.npm-global/bin/skill-steward`.

Hands-on work used an isolated HOME and state directory rather than test-only service mocks:

- A disposable Skill completed scan, Preflight, exact-plan quarantine, exact-plan restore, and automatic refresh. The restored portfolio fingerprint matched the original.
- A Codex integration plan refused destination drift, consumed the failed plan, applied a fresh plan, persisted a ready cached portfolio, and produced a useful recommendation on the first real prompt Hook. Status remained honestly `needs-trust` pending Codex's native trust decision.
- The public Anthropic catalog refreshed at commit `9d2f1ae187231d8199c64b5b762e1bdf2244733d` with 17 candidates. Preflight selected `webapp-testing` as the only install candidate with 91% projected task-term coverage.
- The catalog install preview retained its inspected source. An intentional staged-source modification failed with `SOURCE_DRIFT`; a fresh exact plan then installed the recorded fingerprint with provenance linking the Preflight, candidate, source, and revision.
- Evidence attributed all four current Preflights to `codex` and algorithm v4. The provenance-linked installation produced an explicit conversion of **1/1** without treating lifecycle completion as task success.
- Responsive browser review covered 720, 866, 1100, 1280, and 1600 px. No page developed horizontal overflow. A fresh wide origin opened with a 210 px sidebar, automatically collapsed to 62 px at 720 px, and retained manual sidebar choices.
- Settings exposed 16 KPI definitions with five recommended defaults. Selecting eight KPIs produced eight real Overview cards at both 720 and 1600 px without overflow.
- English and Chinese Overview, Preflight, Evidence, Skills, History, and Settings states were inspected from the installed package. Browser logs contained no errors from the reviewed dashboard origin.
- Full workspace verification rebuilt and typechecked all 13 projects and passed **530 tests**; four Windows-only tests were skipped on macOS and remain covered by the dedicated Windows CI job.

## Alpha.3 dogfood findings

| Priority | Finding | Resolution |
|---|---|---|
| P1 | Long Chinese tasks expanded into single characters and arbitrary adjacent pairs, inflating task terms and giving an unrelated résumé Skill a false match. | Algorithm v4 now uses word-level Simplified- and Traditional-Chinese routing, removes generic workflow framing, preserves meaningful English `Skill` intent, and keeps non-reference ICU/CLDR/Unicode results in a separate algorithm evidence identity. |
| P1 | The Evidence lifecycle badge counted all evidence events while its list counted only lifecycle reasons, producing a non-zero badge beside “No lifecycle events.” | The badge now sums lifecycle reasons only; a fixture with 30 total events and 21 lifecycle reasons locks the distinction. |
| P2 | Capability gaps are still lexical and ordered by task appearance, so labels such as `capture` can be less helpful than a semantic capability phrase. | Accepted for this deterministic release; evaluate semantic or hybrid gap labels only against labeled tasks. |
| P2 | “Active Harnesses” measures Harness visibility in the scanned portfolio, not installed integration trust. | Keep integration truth in Settings for Alpha; rename or add KPI help when coverage accounting is implemented. |
| P2 | Scan History shows portfolio snapshots but does not combine install, governance, policy, and integration transactions into one operational timeline. | Retain separate trusted journals now; consider a read-only unified activity view after native plugin coverage. |

There were no open P0 findings and no open P1 regressions inside the Alpha.3 trust-loop stage. Both stage P1 findings were reproduced from the installed package, fixed with failing tests, re-reviewed independently, rebuilt into a new tarball, reinstalled, and verified again in the browser.

The broader product still has one open **P1 before Beta**: native plugin manifests and nested Skill roots are not yet inventoried comprehensively enough to prove what each Harness can actually see. That gap is the next development phase, not a closed Alpha.3 item. The P2 items in the table remain accepted Alpha limitations; semantic ranking and unified activity history follow after coverage is explicit.

## Alpha.3 product scores

| Dimension | Score | Current assessment |
|---|---:|---|
| Comprehension | 8.7/10 | The three jobs and non-Harness boundary are clear; some KPI and History semantics still need short explanations. |
| Time to first value | 8.3/10 | Scan and explicit Preflight are fast and local; npm publication and a single release install command remain absent. |
| Recommendation quality | 7.8/10 | Real installed/available comparison, marginal value, risks, and Chinese routing work; cross-language semantics and broad labeled evidence do not yet exist. |
| Trust and reversibility | 9.2/10 | Persistent exact plans, single-use claim, source/destination drift refusal, verified staging, quarantine/restore, rollback, and explicit trust states are the strongest part of the product. |
| Harness integration | 8.7/10 | Codex and Claude recommend-and-observe, Copilot is honestly observe-only, and first-prompt readiness is real; native plugin inventory remains incomplete. |
| Evidence usefulness | 8.6/10 | Harness/delivery/algorithm attribution and 1/1 provenance conversion were verified; evidence remains explicitly descriptive rather than an automatic tuner. |
| Interface and configuration | 8.8/10 | Adaptive sidebar behavior, 16 configurable KPIs, bilingual states, and all five viewport checks are strong. |
| Distribution quality | 8.6/10 | Exact npm/pnpm package verification and complete license attribution are in place; signed releases and npm publication are future work. |
| Competitive differentiation | 8.3/10 | Cross-Harness task comparison plus reviewed reversible action and local evidence is distinct; inventory breadth and semantic ranking are the next moat layers. |
| Overall | **8.5/10** | Strong public Alpha and daily dogfood candidate; not yet a fully covered Beta. |

## Alpha.3 competitive position

| Product capability | Current completion | Competitive assessment |
|---|---:|---|
| Scan local Skills and produce a health report | High | Useful foundation but not a moat by itself. |
| Detect overlap, context cost, findings, and removal candidates | Medium-high | More actionable than a linter because it feeds reviewed governance, but runtime invocation frequency is still limited. |
| Inspect a newly discovered Skill before installation | High | Strong trust flow: fixed revision, scripts/findings, persistent staging, exact plan, drift refusal, and provenance. |
| Compare installed and uninstalled Skills for the current task | Medium-high | A real differentiator: one decision model combines relevance, unique coverage, redundancy, risk, context cost, compatibility, and explicit approval. Semantic breadth remains the constraint. |
| Learn from local use and take reversible portfolio action | Medium | Evidence, feedback, lifecycle attribution, install conversion, quarantine, restore, and rollback exist; automatic calibration is intentionally absent until evidence thresholds and review are met. |
| Become the universal Skill router | Intentionally not pursued | Avoiding prompt execution preserves the product boundary and prevents Skill Steward from turning into another small Harness. |

The strongest defensible path remains: **native inventory coverage → task-specific comparison → exact reviewed action → privacy-safe local evidence → reviewed calibration**. The product should compete on trustworthy cross-Harness decisions and recovery, not on owning the chat loop.

## Earlier Alpha.2 executive verdict

Skill Steward has a credible core: local inventory, task-time comparison, reviewed installation, and recoverable quarantine solve a real problem for people who use Agent Skills across more than one coding tool. Its strongest quality is operational trust. Its weakest tested quality is still task-routing depth: the current deterministic algorithm is useful as a reviewed assistant, not as an autonomous semantic router.

The original tested baseline earned **6.2/10 overall**. After correcting the observed precision, truthfulness, attribution, feedback, packaging, and documentation failures, the same Alpha.2 rubric gave that Alpha.2 build **7.9/10**. The repeat-use verdict became **yes for portfolio review, interactive Preflight, and reversible governance**. It remained **no for unattended routing on every prompt** until broader labeled evidence could demonstrate recommendation quality beyond the tested cases.

## Earlier Alpha.2 scope and tested environments

The review used both clean and lived-in environments on macOS with Node.js 22 and pnpm 10:

- The active global binary initially reported **global 0.4.0-alpha.1**, while the checkout declared **repository 0.5.0-alpha.1**. The reviewed changes were then versioned separately; the final package was rebuilt, installed globally, and verified as **0.5.0-alpha.2**.
- A temporary state directory exercised a **clean first run** with no prior reports, catalogs, evidence, integrations, or governance history.
- A real **25-Skill portfolio** exercised discovery, scan, findings, overlap, report, dashboard, and task routing against non-synthetic installed content.
- The public Anthropic catalog was explicitly enabled and refreshed, producing **17 available candidates** for installed-versus-available Preflight comparison. Other built-in sources remained disabled unless deliberately selected.
- Temporary-HOME fixtures exercised managed integrations for **Codex, Claude Code, and GitHub Copilot CLI**, including apply, protocol behavior, drift checks, and removal while preserving unrelated configuration.
- Minimal and learning evidence policies were exercised with explicit feedback, privacy canaries, export, compaction, and erase-plan review.
- A disposable Skill completed **quarantine and restore**, including human-readable plans and history. Separate hands-on runs confirmed both vault-drift and destination-conflict refusal with non-zero exits.
- A direct CLI pack rebuilt all workspace dependencies before bundling, preventing stale package output from surviving a source fix.
- The packaged Codex integration was installed for ongoing development and correctly reported `needs-trust` until Codex's native trust review is completed.
- Responsive inspection covered **720 px** and **1600 px** viewports. Existing automated layout gates at **866 px**, **1100 px**, and **1280 px** remained part of regression coverage.

No private prompt, transcript, state file, or Skill body was uploaded during this review.

## Journeys and evidence

| Journey | What was exercised | Evidence used | Result at tested baseline |
|---|---|---|---|
| Install and first run | Source build, local pack, global install, version check, new state directory | CLI version, build output, empty dashboard and scan | Build was straightforward, but the stale global binary could silently test the wrong release. |
| Understand the portfolio | Discover, scan, findings, overlap, report, Overview, Skills, Findings, History | Real 25-Skill report and localized dashboard captures | Useful breadth, but empty and synthetic presentation states could look like real measurements. |
| Preflight a task | Installed-only and installed-plus-catalog runs across document, review, and generic tasks | Human output, JSON output, stored privacy-reduced record | Candidate separation was understandable; lexical errors produced high-cost false positives. |
| Find an uninstalled Skill | Enable/refresh Anthropic source and compare 17 candidates | Catalog status, revision metadata, Preflight decisions | Opt-in and cached behavior were clear; an available item remained visibly distinct from an installed Skill. |
| Configure a Harness | Plan/apply/remove against all three adapters | Temporary-HOME fixture and capability matrix | Codex and Claude recommend-and-observe behavior was coherent; Copilot correctly remained observe-only. |
| Give feedback | Inspect Evidence dashboard and CLI after a Preflight | Stored record, command help, evidence summary | Dashboard feedback existed, but there was no CLI path for Preflight feedback. |
| Change safely | Inspect install plan, quarantine, history, restore, and drift refusal | Operation plan, journal entry, before/after fingerprint | Recovery mechanics were strong; raw identifiers and hashes made normal human output harder to trust. |
| Use at different sizes/locales | English and Chinese captures across narrow and wide layouts | 720/866/1100/1280/1600 px checks | Core layouts remained usable; documentation needed a strict locale-to-screenshot rule and a shorter orientation path. |

Automated evidence includes package build/type/test gates, repository documentation assertions, temporary-HOME binary tests, privacy canaries, and responsive dashboard tests. Hands-on evidence was used for comprehension, command discoverability, recommendation quality, and whether an operation plan was understandable before confirmation.

## Findings

### Product definition and first value

The former “cross-Harness control plane” opening described architecture before user value. A new reader had to infer whether Skill Steward was an agent runner, a Harness, a catalog, or a dashboard. Installation was detailed, but the first useful path was buried under feature inventory.

The global/repository version mismatch also showed a practical first-run trap: a successful command could still be the wrong build. Version checking belongs next to local-pack instructions.

### Truthfulness and attribution

- An **empty scanned portfolio reported health 100** instead of an unscored empty state.
- Settings preview showed the **synthetic KPI value 92**, which could be mistaken for current portfolio data.
- At the tested baseline, findings omitted the affected Skill, forcing the user to identify the target from IDs or surrounding context.
- Normal governance output exposed hashes and other internal identifiers where the Skill display name was the decision-relevant label.

These are not cosmetic defects. Each one weakens confidence in whether the interface is describing the user's machine or an implementation artifact.

### Preflight precision and feedback

- A **PDF task selected docx**, even though the docx description explicitly excluded PDF work.
- Lightweight stemming corrupted **this / does / missing** into misleading tokens such as `thi`, `doe`, and `mis`.
- A **one-word project-scope false positive** promoted a project Skill based on a generic overlap rather than convincing task fit.
- The human output expanded machine reason codes and long excluded lists instead of leading with the decision.
- There was **no CLI path for Preflight feedback**, despite feedback being central to the Evidence model.

These errors directly affect the product promise. Recommending the wrong document Skill is more damaging than omitting a secondary dashboard metric because it changes the user's next action.

### Coverage and measurement boundaries

- Installed-root scanning has a **native plugin Skill blind spot**: a Skill nested inside some natively installed plugin layouts may not appear even though public plugin catalogs can be indexed.
- Harness lifecycle events describe delivery, stop, and session boundaries; lifecycle completion is not task success and must not be presented as a success rate.
- The current evidence base is too small for automatic tuning. Readiness thresholds permit a separate review; they do not authorize silent changes to weights or thresholds.

## Changes implemented after the baseline

| Baseline problem | Implemented response | Verification gate |
|---|---|---|
| Product purpose was unclear | Rewriting both README openings around inventory, current-task Preflight, and reviewed reversible change; explicitly saying the product is a local companion, not a Harness | Repository assertions for exact bilingual themes and early three-job sections |
| First-use path was buried | Moving a scan/Preflight/dashboard path near the top and adding a global version check beside local packing | Manual clean-state read-through and valid commands |
| Empty scan looked perfect | Rendering an unscored empty state instead of health 100 | Overview and History empty-report tests |
| Synthetic Settings number looked live | Reusing current KPI formatting and avoiding the synthetic KPI value 92 | Settings KPI tests against live fixture data |
| Request failure looked like a genuinely empty portfolio | Rendering localized loading/error/retry states before any empty-state conclusion | Dashboard failure-response tests for Findings, History, Skills, and Overview |
| Findings looked like a complete list although the API returns five priorities | Labeling the page as a five-item priority view | Findings presentation test |
| Findings lacked ownership | Resolving affected Skill names in reports, Findings, and Overview | Report and dashboard attribution tests |
| PDF/docx and negative-routing error | Recognizing narrow English `do not use ... for/when ...` clauses in deterministic Preflight algorithm v3 | Focused PDF-versus-docx test |
| Corrupted stemming | Tightening normalization for this / does / missing and similar suffix cases | Tokenizer regressions |
| Generic project false positive | Requiring stronger term evidence unless the candidate name matches | Project-scope regression test |
| CLI decision was noisy | Using readable reason labels, bounding excluded output, and showing the run ID | Human renderer tests |
| Feedback required the dashboard | Adding an explicit CLI feedback command backed by the existing evidence store | CLI feedback persistence test |
| Governance action labels exposed hashes or path names | Showing the metadata display name in plan headings, confirmations, and history; exact paths and fingerprints remain visible inside reviewed plans and JSON | Governance CLI test |
| Direct packing could bundle stale workspace output | Rebuilding every CLI workspace dependency in `prepack` before bundling the CLI | Repository guard plus direct-pack build log |
| Untrusted Skill metadata could inject terminal control sequences | Escaping C0/C1, ANSI/OSC starters, and bidirectional formatting controls at human Preflight and governance output boundaries | Malicious-name and reason-detail CLI regressions |
| Incomplete CLI feedback could be mistaken for only the missing items | Defining `--candidate` as the complete correct recommendation set in help, errors, both READMEs, and the Alpha protocol | CLI feedback validation test |
| Documentation described algorithm v2 | Aligning public architecture, Alpha protocol, changelog, and README with algorithm v3 and the feedback path | Repository documentation test |

## Alpha.2 post-fix verification

The Alpha.2 build was checked through the same user journeys, not only by reading the changed source:

- A clean package was created with the documented `pnpm --filter skill-steward pack` command. Its prepack log rebuilt all 12 CLI dependencies before producing the tarball.
- The tarball was installed globally and `skill-steward --version` returned `0.5.0-alpha.2`.
- English and Chinese Preflight runs showed readable Latin and Chinese capability gaps. The tested Chinese task produced `制作 / 文件 / 润色 / 布局`, without one-character tokenizer fragments.
- Dashboard failure fixtures showed localized retry states instead of false empty portfolios, findings, history, or Skill inventories.
- Human Preflight and governance regressions verified that control characters in untrusted names and reason text are rendered as visible escapes rather than terminal instructions.
- CLI feedback stored a useful label against the original recommendation set; incomplete feedback without a corrected candidate was rejected.
- Empty portfolio views no longer displayed a perfect score, Settings reused live report values, and affected Skill names appeared in findings and governance actions.
- A disposable governance journey completed quarantine and restore. Later restore attempts refused both modified vault content and an occupied destination without overwriting either copy.
- Overview, Preflight, and Settings were inspected at 720, 866, 1100, 1280, and 1600 px. No horizontal page overflow occurred; the sidebar defaulted to collapsed below 1100 px and expanded at wider desktop sizes.
- The Codex integration was installed from the packaged CLI for continued dogfooding. Its `needs-trust` status is explicit rather than being reported as fully active before native approval.
- A live development-task Preflight completed through the global package but missed the relevant `maintaining-session-requirements` Skill. The run was labeled `incomplete` with the correct candidate through the new CLI feedback path. This is direct evidence of the remaining lexical ceiling, not a success metric.

The final `pnpm check` run rebuilt all packages, passed typechecking in all 13 workspace projects, and passed **290 tests** across 88 test files. The screenshots in the public READMEs use local example data; they demonstrate interface states, not adoption or outcome metrics.

## Accepted future gaps

The following items remain outside the implemented scope:

- Native plugin inventory remains incomplete until installed plugin manifests and nested Skill roots can be discovered without pretending every vendor layout is stable.
- Deterministic lexical ranking still lacks semantic understanding. Algorithm v4 repairs the observed English-boundary and Chinese single-character failures; it does not prove broad task-routing quality.
- The final dogfood task confirmed that ceiling: a product-review prompt did not infer that a long evolving session needed the requirements-maintenance Skill until a human supplied the corrected candidate.
- Lifecycle evidence remains operational evidence, not task outcome. Measuring task success would require a separately designed, privacy-preserving and user-reviewable signal.
- GitHub Copilot CLI remains observe-only. There is no supported automatic prompt recommendation injection in this release.
- Public catalog refresh remains HTTPS-only and credential-free; private repositories and SSH sources are out of scope.
- Finding explanations remain English in the Chinese dashboard.
- Evidence volume has not reached the published calibration thresholds of 100 labeled preflights, 30 corrected sets, and 20 portfolio fingerprints.

## Product scores

This table preserves the Alpha.2 checkpoint for comparison with the current Alpha.3 score near the top of the document. Product definition, task choice, and safe change carry the most weight because they are the three primary user jobs.

| Dimension | Weight | Baseline | Alpha.2 post-fix | Reason for the Alpha.2 score |
|---|---:|---:|---:|---|
| Problem value | 5% | 8/10 | 8/10 | Skill sprawl, task choice, and safe removal remain real recurring problems for multi-tool users. |
| Product definition | 15% | 4/10 | 8/10 | The opening now states the three jobs directly and makes the non-Harness boundary explicit. |
| Time to first value | 10% | 6/10 | 7.5/10 | A short first-use path, version check, and self-contained pack command remove the observed setup traps; npm publication is still absent. |
| Portfolio understanding | 10% | 7/10 | 8/10 | Empty state, KPI provenance, affected-Skill attribution, and request-error states are now truthful; native plugin inventory remains incomplete. |
| Preflight decision quality | 20% | 4/10 | 7/10 | The tested negative-routing, stemming, weak-match, Chinese-label, and terminal-output failures are fixed; lexical ranking still lacks semantic breadth. |
| Safety and reversibility | 20% | 8/10 | 8.5/10 | Human-readable plans, drift refusal, conflict refusal, backups, quarantine, and restore all passed hands-on checks. |
| Integration honesty | 10% | 8/10 | 8/10 | Capabilities still distinguish recommend-and-observe from Copilot observe-only and Codex `needs-trust`. |
| Evidence usefulness | 5% | 6/10 | 7.5/10 | Privacy boundaries remain strong and CLI feedback is now usable; lifecycle evidence still is not task-success evidence. |
| Interface responsiveness | 5% | 8/10 | 8.5/10 | Three core pages passed all five viewport checks with adaptive sidebar behavior and no page overflow. |
| Weighted overall | 100% | **6.2/10** | **7.9/10** | Strong enough for continued interactive use and dogfooding, but not for unattended task routing. |

## Repeat-use verdict

**Yes, with an explicit boundary.** I would keep Skill Steward installed and use it after Skill/plugin changes, before unfamiliar tasks, and whenever a Skill needs to be installed, quarantined, or restored. The inventory and governance journeys are already worth returning to. Preflight is also worth using interactively because the decision, exclusions, source, and feedback path are visible.

I would not yet make it an invisible autonomous router on every coding prompt. That stronger claim requires explicit scan coverage for native plugin contents and enough reviewed real-task labels to show that recommendations improve task choice rather than merely correlate with lifecycle completion.

## Alpha.2 priorities at that checkpoint

### P0 — completed in this stage

The algorithm v3 regressions, empty/error-state truthfulness, affected-Skill attribution, human and terminal-safe governance names, bounded Preflight output, CLI feedback path, and stale-packaging guard are implemented and exercised.

### P1

Close the native plugin Skill blind spot or make per-Harness scan coverage visible enough that users can tell what was and was not inspected. Keep the three-job product definition stable across README, CLI help, and first-run UI.

### P2

Collect reviewed real-task labels until the published readiness thresholds are met. Design a privacy-safe task-outcome study separately from lifecycle events, and evaluate semantic or hybrid routing only against that labeled set.

### P3

Broaden native adapters only where Hook semantics, trust, fail-open behavior, and reversible configuration can be tested. Add signed release artifacts and supply-chain attestations after the core journeys remain reliable across releases.
