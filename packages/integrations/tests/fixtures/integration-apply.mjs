import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyIntegrationPlanInternal,
  integrationPlanSchema,
  planIntegration
} from "../../src/config.ts";

const [
  home,
  stateDirectory,
  harness,
  readyPath,
  barrierPath,
  countText,
  companionSourceDirectory
] = process.argv.slice(2);
await writeFile(readyPath, "ready\n", "utf8");
while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await delay(2);
  }
}
for (let index = 0; index < Number(countText); index += 1) {
  const options = { home, stateDirectory, companionSourceDirectory };
  const unowned = await planIntegration(harness, options);
  const fingerprint = unowned.companion.after.fingerprint;
  const plan = integrationPlanSchema.parse({
    ...unowned,
    companion: {
      ...unowned.companion,
      action: "none",
      expectedBefore: { state: "exact", fingerprint },
      proof: {
        kind: "recorded",
        recordId: "fixture-current-companion",
        installedFingerprint: fingerprint
      }
    }
  });
  await applyIntegrationPlanInternal(plan, options);
}
