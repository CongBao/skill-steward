# Contributing to Skill Steward

Thank you for helping make local Agent Skills safer and easier to understand.

## Before opening a change

1. Search existing issues and discussions.
2. For a large behavior or data-model change, open a proposal before implementation.
3. Keep the product local-first, deterministic, and compatible with multiple harnesses.
4. Never add telemetry, remote assets, or Skill-content uploads without an explicit design and security review.

## Development setup

Requirements: Node.js 22 or newer and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node packages/cli/dist/main.js dashboard --no-open --port 4762
```

## Change workflow

- Write a failing test before behavior changes.
- Keep packages focused: engine code must not depend on the Web UI.
- Add Chinese and English copy together.
- Test narrow, medium, and wide layouts for UI changes.
- Add or update security tests for filesystem or installation behavior.
- Run `pnpm check` and `git diff --check` before requesting review.

## Release identity changes

The CLI and six native packages share one reviewed [release contract](docs/release-contract.md). Do not edit their manifest versions or npm tags independently. Update `release-contract.json`, run `pnpm release:sync`, review every generated manifest change, and finish with `pnpm release:check` and `CI=true pnpm check`.

`release:sync` is never part of build or pack. Running the check or synchronizer does not publish a package or create a GitHub Release.

Publication remains a separate reviewed operation. Read [Native package publication](docs/native-publication.md) and [CLI npm publication](docs/cli-publication.md) before changing either protected workflow.

## Commits and pull requests

Use a concise imperative commit subject, such as `feat: validate zip entry paths`. A pull request should explain the user outcome, security impact, tests run, screenshots for visible changes, and any compatibility trade-offs.

By contributing, you agree that your contribution is licensed under the repository's MIT License and follows the [Code of Conduct](CODE_OF_CONDUCT.md).
