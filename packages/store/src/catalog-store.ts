import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogSnapshotSchema,
  catalogSourcePresets,
  catalogSourceSchema,
  type CatalogSnapshot,
  type CatalogSource
} from "@skill-steward/catalog";
import { z } from "zod";

const CATALOG_SOURCES_FILE = "catalog-sources.json";
const CATALOG_INDEX_FILE = "catalog-index.json";

const catalogSourcesFileSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(catalogSourceSchema).max(8)
}).superRefine(({ sources }, context) => {
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Catalog source IDs must be unique",
      path: ["sources"]
    });
  }
  if (sources.filter(({ enabled }) => enabled).length > 5) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At most five catalog sources may be enabled",
      path: ["sources"]
    });
  }
});

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function atomicWrite(
  stateDirectory: string,
  fileName: string,
  value: unknown
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const destination = join(stateDirectory, fileName);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, destination);
}

export async function readCatalogSources(
  stateDirectory: string
): Promise<CatalogSource[]> {
  try {
    const source = await readFile(join(stateDirectory, CATALOG_SOURCES_FILE), "utf8");
    return catalogSourcesFileSchema.parse(JSON.parse(source)).sources;
  } catch (error) {
    if (isMissing(error)) {
      return catalogSourcesFileSchema.parse({
        schemaVersion: 1,
        sources: catalogSourcePresets
      }).sources;
    }
    throw error;
  }
}

export async function writeCatalogSources(
  stateDirectory: string,
  sources: CatalogSource[]
): Promise<void> {
  const payload = catalogSourcesFileSchema.parse({ schemaVersion: 1, sources });
  await atomicWrite(stateDirectory, CATALOG_SOURCES_FILE, payload);
}

export async function readCatalogSnapshot(
  stateDirectory: string
): Promise<CatalogSnapshot | null> {
  try {
    const source = await readFile(join(stateDirectory, CATALOG_INDEX_FILE), "utf8");
    return catalogSnapshotSchema.parse(JSON.parse(source));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function writeCatalogSnapshot(
  stateDirectory: string,
  snapshot: CatalogSnapshot
): Promise<void> {
  const payload = catalogSnapshotSchema.parse(snapshot);
  await atomicWrite(stateDirectory, CATALOG_INDEX_FILE, payload);
}
