# Security Policy

## Supported versions

Security fixes are applied to the latest published alpha or release. Pre-release versions may change their local state schema, but fixes will avoid destructive migration whenever possible.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could enable path traversal, arbitrary file writes, source execution, token disclosure, or unsafe rollback. Use the repository's private security-advisory channel or another private maintainer contact listed by the hosting project. Include:

- affected version or commit;
- operating system and Node.js version;
- minimal reproduction using non-sensitive fixtures;
- expected and observed filesystem changes;
- potential impact and any known workaround.

Maintainers should acknowledge a complete report within seven days, share a remediation plan when the issue is confirmed, and coordinate disclosure after a fix is available.

## Security model

Skill Steward binds to loopback, serves same-origin assets, sends no telemetry, and never executes installation-source content. Installation requires preview, a target harness and scope, explicit confirmation, atomic writes, backups for replacement, and fingerprint-guarded rollback. See [Privacy and security](README.md#privacy-and-security) for current boundaries.
