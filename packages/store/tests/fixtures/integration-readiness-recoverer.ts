import { readFile } from "node:fs/promises";
import {
  restoreIntegrationReadinessFromArtifact
} from "../../src/integration-readiness-recovery.js";
import { withIntegrationMutationLease } from "../../src/integration-mutation-lease.js";

async function main(): Promise<void> {
  const [stateDirectory, artifactPath] = process.argv.slice(2);
  if (!stateDirectory || !artifactPath) throw new Error("state directory and artifact are required");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  await withIntegrationMutationLease(stateDirectory, async (leaseContext) => {
    await restoreIntegrationReadinessFromArtifact(artifact, { stateDirectory, leaseContext });
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
