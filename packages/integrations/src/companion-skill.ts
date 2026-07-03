import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fingerprintDirectory } from "@skill-steward/installer";

export class CompanionSkillError extends Error {
  readonly code = "SHARED_SKILL_CONFLICT" as const;

  constructor(message: string) {
    super(message);
    this.name = "CompanionSkillError";
  }
}

export function companionSkillDirectory(home: string): string {
  return join(home, ".agents", "skills", "skill-steward-preflight");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function installCompanionSkill(input: {
  home: string;
  sourceDirectory: string;
}): Promise<{ created: boolean; path: string }> {
  const destination = companionSkillDirectory(input.home);
  const sourceFingerprint = await fingerprintDirectory(input.sourceDirectory);
  if (await exists(destination)) {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CompanionSkillError("Companion Skill destination is not a regular directory");
    }
    if (await fingerprintDirectory(destination) !== sourceFingerprint) {
      throw new CompanionSkillError("Existing companion Skill differs from the packaged version");
    }
    return { created: false, path: destination };
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await cp(input.sourceDirectory, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { created: true, path: destination };
}

export async function removeManagedCompanionSkill(input: {
  home: string;
  sourceDirectory: string;
}): Promise<boolean> {
  const destination = companionSkillDirectory(input.home);
  if (!await exists(destination)) return false;
  const metadata = await lstat(destination);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    await fingerprintDirectory(destination) !== await fingerprintDirectory(input.sourceDirectory)
  ) {
    return false;
  }
  await rm(destination, { recursive: true, force: true });
  return true;
}
