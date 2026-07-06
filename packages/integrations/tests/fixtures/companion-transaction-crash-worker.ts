import { rename, rmdir, unlink, writeFile } from "node:fs/promises";
import {
  applyReviewedCompanionIntegrationTransaction,
  disconnectCompanionIntegrationTransaction,
  type CompanionTransactionBoundary
} from "../../src/companion-transaction.js";

async function main(): Promise<void> {
  const [
    home,
    stateDirectory,
    companionSourceDirectory,
    planId,
    operation,
    boundaryInput,
    position,
    occurrenceInput,
    markerPath
  ] = process.argv.slice(2);
  if (
    !home
    || !stateDirectory
    || !companionSourceDirectory
    || !planId
    || (operation !== "apply" && operation !== "disconnect")
    || !boundaryInput
    || (position !== "before" && position !== "after")
    || !occurrenceInput
    || !markerPath
  ) {
    throw new Error("Crash worker arguments are incomplete");
  }
  const boundary = boundaryInput as CompanionTransactionBoundary;
  const occurrence = Number(occurrenceInput);
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
    throw new Error("Crash occurrence must be a positive integer");
  }
  let seen = 0;
  const crash = async (candidate: CompanionTransactionBoundary): Promise<void> => {
    if (candidate !== boundary || ++seen !== occurrence) return;
    await writeFile(markerPath, `${position}:${boundary}:${occurrence}\n`, { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
    await new Promise<never>(() => undefined);
  };

  const apply = operation === "disconnect"
    ? disconnectCompanionIntegrationTransaction
    : applyReviewedCompanionIntegrationTransaction;
  await apply(planId, {
    home,
    stateDirectory,
    companionSourceDirectory,
    expectedHarness: "codex",
    now: () => new Date("2026-07-06T06:00:00.000Z"),
    generateReadiness: async () => ({
      schemaVersion: 1,
      generatedAt: "2026-07-06T06:00:01.000Z",
      portfolioFingerprint: `sha256:${"a".repeat(64)}`,
      skills: [],
      findings: []
    })
  }, {
    assertNativeCapability: async () => undefined,
    beforeBoundary: position === "before" ? crash : async () => undefined,
    afterBoundary: position === "after" ? crash : async () => undefined,
    ownedTreeHooks: {
      platform: process.platform,
      renamePath: rename,
      unlinkPath: unlink,
      rmdirPath: rmdir
    }
  });
  throw new Error(`Boundary ${boundary} occurrence ${occurrence} was not reached`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
