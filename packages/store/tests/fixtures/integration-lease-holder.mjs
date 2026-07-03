import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { withIntegrationMutationLease } from "../../src/integration-mutation-lease.ts";

const [stateDirectory, readyPath, releasePath] = process.argv.slice(2);
await withIntegrationMutationLease(stateDirectory, async () => {
  await writeFile(readyPath, "ready\n", "utf8");
  while (true) {
    try {
      await access(releasePath);
      return;
    } catch {
      await delay(2);
    }
  }
});
