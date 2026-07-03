import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyIntegrationPlan,
  planIntegration
} from "../../dist/src/config.js";

const [home, stateDirectory, harness, readyPath, barrierPath, countText] = process.argv.slice(2);
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
  const plan = await planIntegration(harness, { home, stateDirectory });
  await applyIntegrationPlan(plan, { home, stateDirectory });
}
