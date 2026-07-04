import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { INVENTORY_SCAN_HARD_MAXIMA, InventoryError } from "./domain.js";

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`
      ) &&
      !isAbsolute(pathFromRoot)
    );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function nearestExistingRealpath(
  root: string,
  target: string
): Promise<string | undefined> {
  let current = target;
  for (
    let attempt = 0;
    attempt <= INVENTORY_SCAN_HARD_MAXIMA.maxDepth;
    attempt += 1
  ) {
    if (!isContained(root, current)) return undefined;
    try {
      return await realpath(current);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  throw new InventoryError(
    "COMPONENT_PATH_DEPTH_LIMIT",
    "Plugin component ancestor probing exceeded the depth limit"
  );
}

function relativeComponentDepth(path: string): number | undefined {
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return undefined;
  return path.split(/[\\/]+/u).filter((component) =>
    component.length > 0 && component !== "."
  ).length;
}

export async function resolveContainedComponent(
  pluginRoot: string,
  declaredPath: string
): Promise<string> {
  if (declaredPath.trim() === "") {
    throw new InventoryError(
      "COMPONENT_PATH_EMPTY",
      "Plugin component path is empty"
    );
  }
  if (
    isAbsolute(declaredPath) ||
    posix.isAbsolute(declaredPath) ||
    win32.isAbsolute(declaredPath)
  ) {
    throw new InventoryError(
      "COMPONENT_PATH_ABSOLUTE",
      "Plugin component path must be relative"
    );
  }
  const componentDepth = relativeComponentDepth(declaredPath);
  if (
    componentDepth !== undefined &&
    componentDepth > INVENTORY_SCAN_HARD_MAXIMA.maxDepth
  ) {
    throw new InventoryError(
      "COMPONENT_PATH_DEPTH_LIMIT",
      "Plugin component path exceeds the depth limit"
    );
  }

  let physicalRoot: string;
  try {
    physicalRoot = await realpath(resolve(pluginRoot));
  } catch {
    throw new InventoryError(
      "COMPONENT_PATH_MISSING",
      "Plugin root cannot be resolved"
    );
  }

  const normalizedTarget = resolve(physicalRoot, declaredPath);
  if (!isContained(physicalRoot, normalizedTarget)) {
    throw new InventoryError(
      "COMPONENT_PATH_ESCAPE",
      "Plugin component path leaves the plugin root"
    );
  }

  let physicalTarget: string;
  try {
    physicalTarget = await realpath(normalizedTarget);
  } catch {
    const nearestPhysicalAncestor = await nearestExistingRealpath(
      physicalRoot,
      normalizedTarget
    );
    if (
      nearestPhysicalAncestor !== undefined &&
      !isContained(physicalRoot, nearestPhysicalAncestor)
    ) {
      throw new InventoryError(
        "COMPONENT_REALPATH_ESCAPE",
        "Plugin component ancestor real path leaves the plugin root"
      );
    }
    throw new InventoryError(
      "COMPONENT_PATH_MISSING",
      "Plugin component path cannot be resolved"
    );
  }
  if (!isContained(physicalRoot, physicalTarget)) {
    throw new InventoryError(
      "COMPONENT_REALPATH_ESCAPE",
      "Plugin component real path leaves the plugin root"
    );
  }

  return physicalTarget;
}
