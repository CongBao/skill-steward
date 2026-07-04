import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { appendIntegrationRecord } from "../../src/integration-store.ts";

const [stateDirectory, harness, prefix, readyPath, barrierPath, countText, version] = process.argv.slice(2);
const count = Number(countText);
await writeFile(readyPath, "ready\n", "utf8");
while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await delay(2);
  }
}
for (let index = 0; index < count; index += 1) {
  const suffix = String(index).padStart(3, "0");
  const createdAt = new Date(Date.UTC(2026, 6, 3) + index).toISOString();
  const base = {
    schemaVersion: 1,
    id: `${prefix}-${suffix}`,
    harness,
    action: "apply",
    status: "installed",
    targetPath: `/tmp/home/${harness}.json`,
    beforeFingerprint: `sha256:${"a".repeat(64)}`,
    afterFingerprint: `sha256:${"b".repeat(64)}`,
    installedEntryFingerprint: `sha256:${"c".repeat(64)}`,
    createdAt
  };
  await appendIntegrationRecord(stateDirectory, version === "v2" ? {
    ...base,
    schemaVersion: 2,
    companion: {
      action: "none",
      path: "/tmp/home/.agents/skills/skill-steward-preflight",
      before: { state: "exact", fingerprint: `sha256:${"d".repeat(64)}` },
      after: { state: "exact", fingerprint: `sha256:${"d".repeat(64)}` },
      source: { fingerprint: `sha256:${"d".repeat(64)}` },
      proof: { category: "recorded" },
      installedFingerprint: `sha256:${"d".repeat(64)}`,
      consumers: [harness]
    },
    trigger: { planId: `${prefix}-${suffix}`, harness, createdAt }
  } : base);
}
