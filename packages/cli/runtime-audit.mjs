import { createHash } from "node:crypto";

const DESCRIPTION = "Generated full runtime bundle audit; update only with the explicit maintainer command.";
const HASH = /^[a-f0-9]{64}$/;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function createRuntimeAuditSnapshot(packages, notices) {
  const entries = packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.license,
    source: entry.source,
    surfaces: [...entry.surfaces].sort(compare),
    rationale: entry.rationale ?? null,
    attributions: entry.attributions.map((attribution) => ({
      kind: attribution.kind,
      source: attribution.source,
      reason: attribution.reason ?? null,
      textSha256: sha256(attribution.text)
    }))
  })).sort((left, right) => compare(`${left.name}@${left.version}`, `${right.name}@${right.version}`));
  return {
    schemaVersion: 1,
    description: DESCRIPTION,
    noticesSha256: sha256(notices),
    packages: entries
  };
}

function exactKeys(value, keys, context) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort(compare)) !== JSON.stringify([...keys].sort(compare))
  ) {
    throw new Error(`Runtime audit ${context} has invalid fields`);
  }
}

function nonemptyString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Runtime audit ${context} must be a non-empty string`);
  }
}

export function validateRuntimeAuditSnapshot(snapshot) {
  exactKeys(snapshot, ["schemaVersion", "description", "noticesSha256", "packages"], "snapshot");
  if (
    snapshot.schemaVersion !== 1
    || snapshot.description !== DESCRIPTION
    || !HASH.test(snapshot.noticesSha256)
    || !Array.isArray(snapshot.packages)
    || snapshot.packages.length === 0
  ) {
    throw new Error("Runtime audit snapshot is incomplete");
  }
  const identifiers = [];
  for (const entry of snapshot.packages) {
    exactKeys(
      entry,
      ["name", "version", "license", "source", "surfaces", "rationale", "attributions"],
      "package"
    );
    for (const field of ["name", "version", "license", "source"]) {
      nonemptyString(entry[field], `package ${field}`);
    }
    if (
      !Array.isArray(entry.surfaces)
      || entry.surfaces.length === 0
      || entry.surfaces.some((surface) => typeof surface !== "string" || surface === "")
      || JSON.stringify(entry.surfaces) !== JSON.stringify([...new Set(entry.surfaces)].sort(compare))
      || (entry.rationale !== null && (typeof entry.rationale !== "string" || entry.rationale === ""))
      || !Array.isArray(entry.attributions)
      || entry.attributions.length === 0
    ) {
      throw new Error(`Runtime audit package ${entry.name}@${entry.version} is incomplete`);
    }
    for (const attribution of entry.attributions) {
      exactKeys(attribution, ["kind", "source", "reason", "textSha256"], "attribution");
      nonemptyString(attribution.kind, "attribution kind");
      nonemptyString(attribution.source, "attribution source");
      if (
        (attribution.reason !== null && (
          typeof attribution.reason !== "string" || attribution.reason === ""
        ))
        || !HASH.test(attribution.textSha256)
      ) {
        throw new Error(`Runtime audit attribution for ${entry.name}@${entry.version} is incomplete`);
      }
    }
    identifiers.push(`${entry.name}@${entry.version}`);
  }
  if (
    new Set(identifiers).size !== identifiers.length
    || JSON.stringify(identifiers) !== JSON.stringify([...identifiers].sort(compare))
  ) {
    throw new Error("Runtime audit packages must be unique and sorted");
  }
  return snapshot;
}

export function assertRuntimeAuditSnapshot(actual, expected) {
  validateRuntimeAuditSnapshot(expected);
  try {
    validateRuntimeAuditSnapshot(actual);
  } catch (error) {
    throw new Error("Runtime audit drift detected in generated data", { cause: error });
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Runtime audit drift detected; review and run the explicit maintainer update command");
  }
}

export function manifestPackagesFromAudit(snapshot) {
  validateRuntimeAuditSnapshot(snapshot);
  return snapshot.packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.license,
    source: entry.source,
    surfaces: entry.surfaces,
    ...(entry.rationale === null ? {} : { rationale: entry.rationale }),
    attributions: entry.attributions.map((attribution) => ({
      kind: attribution.kind,
      source: attribution.source,
      ...(attribution.reason === null ? {} : { reason: attribution.reason })
    }))
  }));
}
