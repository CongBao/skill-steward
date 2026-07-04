import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { InventoryError } from "./domain.js";
import {
  DEFAULT_METADATA_IO,
  readBoundedTextInternal,
  type SecureMetadataReadOptions
} from "./metadata-internal.js";
export {
  MAX_METADATA_BYTES,
  type SecureMetadataReadOptions
} from "./metadata-internal.js";
export { resolveContainedComponent } from "./manifest.js";

export async function readBoundedText(
  path: string,
  options: SecureMetadataReadOptions = {}
): Promise<string> {
  return readBoundedTextInternal(path, options, DEFAULT_METADATA_IO);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InventoryError("METADATA_NOT_OBJECT", "Metadata root must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return requireObject(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw new InventoryError("METADATA_INVALID_JSON", "Metadata is not valid JSON");
  }
}

export function parseJsoncObject(text: string): Record<string, unknown> {
  const diagnostics: ParseError[] = [];
  const value: unknown = parseJsonc(text, diagnostics, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (diagnostics.length > 0) {
    throw new InventoryError(
      "METADATA_INVALID_JSONC",
      "Metadata is not valid JSONC",
      diagnostics
    );
  }
  return requireObject(value);
}

export function parseTomlObject(text: string): Record<string, unknown> {
  try {
    return requireObject(parseToml(text));
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    throw new InventoryError("METADATA_INVALID_TOML", "Metadata is not valid TOML");
  }
}

export async function readJsonObject(
  path: string,
  options: SecureMetadataReadOptions = {}
): Promise<Record<string, unknown>> {
  return parseJsonObject(await readBoundedText(path, options));
}

export async function readJsoncObject(
  path: string,
  options: SecureMetadataReadOptions = {}
): Promise<Record<string, unknown>> {
  return parseJsoncObject(await readBoundedText(path, options));
}

export async function readTomlObject(
  path: string,
  options: SecureMetadataReadOptions = {}
): Promise<Record<string, unknown>> {
  return parseTomlObject(await readBoundedText(path, options));
}
