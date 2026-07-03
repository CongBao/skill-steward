import { join, relative } from "node:path";
import {
  resolveHarnessRoot,
  type InstallableHarnessId,
  type InstallScope
} from "@skill-steward/engine";
import { InstallerError } from "./domain.js";

export interface InstallDestinationInput {
  harness: InstallableHarnessId;
  scope: InstallScope;
  home: string;
  workspace?: string;
  name: string;
}

export interface InstallDestination {
  root: string;
  target: string;
}

export function resolveInstallDestination(
  input: InstallDestinationInput
): InstallDestination {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.name)) {
    throw new InstallerError("INVALID_TARGET_NAME", "Skill target name is unsafe");
  }
  const root = resolveHarnessRoot(input);
  const target = join(root, input.name);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith("..") || fromRoot.includes("/../")) {
    throw new InstallerError("DESTINATION_ESCAPE", "Skill destination escapes its harness root");
  }
  return { root, target };
}
