import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import {
  openSpecToolDirectories,
  resolveHarnessRoot,
  type InstallableHarnessId,
  type InstallScope
} from "@skill-steward/engine";
import { z } from "zod";
import { InstallerError } from "./domain.js";

const targetNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const installableHarnessIds = new Set<string>([
  "agents",
  ...openSpecToolDirectories.map(({ id }) => id)
]);
const installableHarnessSchema = z.custom<InstallableHarnessId>(
  (value) => typeof value === "string" && installableHarnessIds.has(value),
  "Unsupported installation Harness"
);
const absoluteNormalizedPathSchema = z.string().min(1).max(4_096).refine(
  (value) => isAbsolute(value) && normalize(value) === value,
  "Path must be absolute and normalized"
);

export const installationRouteSchema = z.object({
  harness: installableHarnessSchema,
  scope: z.enum(["global", "project"]),
  targetName: targetNameSchema,
  workspace: absoluteNormalizedPathSchema
}).strict();

export type InstallationRoute = z.infer<typeof installationRouteSchema>;

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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertPhysicalDirectory(path: string, required: boolean): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new InstallerError(
        "UNSAFE_INSTALL_DESTINATION",
        `Installation destination ancestor '${path}' must be a physical directory`
      );
    }
    return true;
  } catch (error) {
    if (isMissing(error) && !required) return false;
    if (isMissing(error)) {
      throw new InstallerError(
        "UNSAFE_INSTALL_DESTINATION",
        `Installation route anchor '${path}' does not exist`
      );
    }
    throw error;
  }
}

async function assertDestinationAncestors(anchor: string, parent: string): Promise<void> {
  // Node does not expose portable openat/mkdirat primitives. Call this immediately
  // before mutation; concurrent hostile writes by the same OS user are outside the boundary.
  const fromAnchor = relative(anchor, parent);
  if (
    fromAnchor === ".."
    || fromAnchor.startsWith(`..${sep}`)
    || isAbsolute(fromAnchor)
  ) {
    throw new InstallerError(
      "UNSAFE_INSTALL_DESTINATION",
      "Installation destination escapes its route anchor"
    );
  }
  await assertPhysicalDirectory(anchor, true);
  if (fromAnchor.length === 0) return;
  let current = anchor;
  for (const segment of fromAnchor.split(sep)) {
    current = join(current, segment);
    if (!await assertPhysicalDirectory(current, false)) return;
  }
}

export async function resolveVerifiedInstallDestination(input: {
  route: unknown;
  home: string;
}): Promise<InstallDestination> {
  const parsed = installationRouteSchema.safeParse(input.route);
  if (
    !parsed.success
    || !isAbsolute(input.home)
    || normalize(input.home) !== input.home
  ) {
    throw new InstallerError(
      "INVALID_INSTALL_ROUTE",
      "Reviewed installation route is invalid"
    );
  }
  const route = parsed.data;
  const destination = resolveInstallDestination({
    harness: route.harness,
    scope: route.scope,
    home: input.home,
    workspace: route.workspace,
    name: route.targetName
  });
  await assertDestinationAncestors(
    route.scope === "global" ? input.home : route.workspace,
    destination.root
  );
  return destination;
}
