# Security Policy

## Supported versions

Security fixes are applied to the latest published alpha or release. Pre-release versions may change their local state schema, but fixes will avoid destructive migration whenever possible.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could enable raw evidence disclosure, path traversal, arbitrary file writes, source execution, token or HMAC-salt disclosure, unsafe rollback, or loss of the only verified quarantine copy. Use the repository's private security-advisory channel or another private maintainer contact listed by the hosting project. Include:

- affected version or commit;
- operating system and Node.js version;
- minimal reproduction using non-sensitive fixtures;
- expected and observed filesystem changes;
- potential impact and any known workaround.

Maintainers should acknowledge a complete report within seven days, share a remediation plan when the issue is confirmed, and coordinate disclosure after a fix is available.

## Security model

Skill Steward binds to loopback, serves same-origin assets, sends no telemetry, and never executes installation-source content. Mutating loopback requests require a random per-process token. Installation requires preview, a target Harness and scope, explicit confirmation, atomic writes, backups for replacement, and fingerprint-guarded rollback.

Evidence defaults to minimal mode. Learning mode requires a reviewed policy change and stores only strict content-free numeric records plus HMAC-pseudonymous correlation keys. The per-install salt is a private `0600` file, is used only locally, and is excluded from export, API, and UI output. Prompts, extracted terms, working paths, raw Harness identifiers, transcripts, assistant messages, and tool data are not valid evidence fields. Hooks fail open when parsing, HMAC, storage, or analysis fails.

Quarantine and restore require exact, expiring plans. Quarantine verifies a private copy before moving the active Skill; restore refuses destination conflicts and vault drift. Failure recovery is designed to preserve at least one fingerprint-verified copy. The product exposes no permanent governance delete action.

These controls reduce risk but do not make third-party Skills trusted. Catalog classification is not a security endorsement, lifecycle completion is not proof of task success, and ranking never changes automatically from collected evidence. See [Privacy and security](README.md#privacy-and-security) and [Architecture](docs/architecture.md) for current boundaries.
