import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { installationProvenanceSchema, InstallerError } from "./domain.js";
import {
  appendInstallationRecord,
  type InstallationRecord
} from "./journal.js";
import { fingerprintDirectory } from "./manifest.js";
import type { InstallationPlan } from "./planner.js";

export interface ApplyInstallationOptions {
  stateDirectory: string;
  now?: () => number;
  id?: () => string;
  afterBackup?: () => void | Promise<void>;
}

async function pathFingerprint(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) {
      throw new InstallerError("DESTINATION_NOT_DIRECTORY", "Destination is not a directory");
    }
    return fingerprintDirectory(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new InstallerError("UNSAFE_SOURCE_LINK", `Source link '${entry.name}' is not allowed`);
    }
    if (entry.isDirectory()) {
      await copyTree(from, to);
      continue;
    }
    if (!entry.isFile()) {
      throw new InstallerError("UNSAFE_SOURCE_FILE", `Special file '${entry.name}' is not allowed`);
    }
    const metadata = await lstat(from);
    await copyFile(from, to);
    await chmod(to, metadata.mode & 0o777);
  }
}

export async function applyInstallationPlan(
  plan: InstallationPlan,
  options: ApplyInstallationOptions
): Promise<InstallationRecord> {
  const provenance = plan.provenance
    ? installationProvenanceSchema.parse(plan.provenance)
    : undefined;
  if (plan.status !== "ready" || (plan.action !== "create" && plan.action !== "replace")) {
    throw new InstallerError("PLAN_NOT_COMMITTABLE", "Installation plan is not ready to commit");
  }
  const now = options.now ?? Date.now;
  if (now() > plan.expiresAt) {
    throw new InstallerError("PLAN_EXPIRED", "Installation plan has expired");
  }
  if ((await fingerprintDirectory(plan.source)) !== plan.sourceFingerprint) {
    throw new InstallerError("SOURCE_DRIFT", "Installation source changed after planning");
  }
  const currentDestinationFingerprint = await pathFingerprint(plan.destination);
  if (currentDestinationFingerprint !== plan.expectedDestinationFingerprint) {
    throw new InstallerError("DESTINATION_DRIFT", "Installation destination changed after planning");
  }

  const id = (options.id ?? randomUUID)();
  const parent = dirname(plan.destination);
  const name = basename(plan.destination);
  const temporary = join(parent, `.${name}.skill-steward-${id}.tmp`);
  const backupDirectory =
    plan.action === "replace"
      ? join(parent, ".skill-steward-backups", id, name)
      : null;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await copyTree(plan.source, temporary);
  if ((await fingerprintDirectory(temporary)) !== plan.sourceFingerprint) {
    await rm(temporary, { recursive: true, force: true });
    throw new InstallerError("COPY_VERIFICATION_FAILED", "Staged copy fingerprint differs from source");
  }

  let backupMoved = false;
  let installed = false;
  try {
    if ((await pathFingerprint(plan.destination)) !== plan.expectedDestinationFingerprint) {
      throw new InstallerError(
        "DESTINATION_DRIFT",
        "Installation destination changed while the reviewed copy was prepared"
      );
    }
    if (backupDirectory) {
      await mkdir(dirname(backupDirectory), { recursive: true, mode: 0o700 });
      await rename(plan.destination, backupDirectory);
      backupMoved = true;
      await options.afterBackup?.();
    }
    await rename(temporary, plan.destination);
    installed = true;
    const record: InstallationRecord = {
      id,
      status: "installed",
      action: plan.action,
      destination: plan.destination,
      installedFingerprint: plan.sourceFingerprint,
      previousFingerprint: plan.expectedDestinationFingerprint,
      backupDirectory,
      createdAt: new Date(now()).toISOString(),
      ...(provenance ? { provenance } : {})
    };
    await appendInstallationRecord(options.stateDirectory, record);
    return record;
  } catch (error) {
    if (installed) {
      await rm(plan.destination, { recursive: true, force: true });
    }
    if (backupMoved && backupDirectory) {
      await rename(backupDirectory, plan.destination);
    }
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
