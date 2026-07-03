import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { InstallerError } from "./domain.js";
import {
  appendInstallationRecord,
  readInstallationHistory,
  type InstallationRecord
} from "./journal.js";
import { fingerprintDirectory } from "./manifest.js";

export interface RollbackOptions {
  stateDirectory: string;
  now?: () => number;
}

export async function rollbackInstallation(
  transactionId: string,
  options: RollbackOptions
): Promise<InstallationRecord> {
  const history = await readInstallationHistory(options.stateDirectory);
  const transaction = history.find(({ id }) => id === transactionId);
  if (!transaction) {
    throw new InstallerError("TRANSACTION_NOT_FOUND", "Installation transaction was not found");
  }
  if (transaction.status !== "installed") {
    throw new InstallerError("TRANSACTION_ALREADY_ROLLED_BACK", "Transaction is not active");
  }
  if ((await fingerprintDirectory(transaction.destination)) !== transaction.installedFingerprint) {
    throw new InstallerError("DESTINATION_DRIFT", "Installed Skill changed after the transaction");
  }

  const temporary = join(
    dirname(transaction.destination),
    `.${basename(transaction.destination)}.rollback-${randomUUID()}`
  );
  await rename(transaction.destination, temporary);
  try {
    if (transaction.backupDirectory) {
      if (
        transaction.previousFingerprint &&
        (await fingerprintDirectory(transaction.backupDirectory)) !==
          transaction.previousFingerprint
      ) {
        throw new InstallerError("BACKUP_DRIFT", "Installation backup changed after the transaction");
      }
      await rename(transaction.backupDirectory, transaction.destination);
    }
    await rm(temporary, { recursive: true, force: true });
  } catch (error) {
    await rename(temporary, transaction.destination);
    throw error;
  }

  const rolledBack: InstallationRecord = {
    ...transaction,
    status: "rolled-back",
    rolledBackAt: new Date((options.now ?? Date.now)()).toISOString()
  };
  await appendInstallationRecord(options.stateDirectory, rolledBack);
  return rolledBack;
}
