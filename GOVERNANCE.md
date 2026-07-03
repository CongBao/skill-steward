# Governance

Skill Steward is maintained through public, evidence-driven technical decisions.

## Roles

- **Contributors** propose issues, documentation, tests, and code.
- **Maintainers** review changes, triage reports, manage releases, and protect the security and local-first guarantees.

## Decision making

Routine changes are accepted through maintainer review and passing checks. Changes that alter the trust boundary, local data model, supported harness semantics, or public API require a written design, an explicit migration story, and security-focused tests. Maintainers seek rough consensus; when consensus is not possible, the designated release maintainer records the decision and rationale publicly.

## Releases

Releases require a clean build, typecheck, unit and browser acceptance, packed-package smoke test, changelog update, and review of bundled dependencies. No individual may approve and publish a security-sensitive change alone.

## Project direction

The project prioritizes explainable local analysis, safe cross-harness operations, and measurable compatibility over becoming another complete agent harness.
