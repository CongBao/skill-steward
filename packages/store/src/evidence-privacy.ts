import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  pseudonymousKeySchema,
  type PseudonymousKey
} from "@skill-steward/evidence";

const SALT_FILE = "evidence-salt";
const SALT_BYTES = 32;

export type EvidenceKeyNamespace = "session" | "turn" | "workspace";

export interface EvidencePrivacy {
  key(namespace: EvidenceKeyNamespace, raw: string): PseudonymousKey;
}

export class EvidencePrivacyError extends Error {
  constructor(
    public readonly code: "INVALID_EVIDENCE_SALT" | "INVALID_EVIDENCE_IDENTIFIER",
    message: string
  ) {
    super(message);
    this.name = "EvidencePrivacyError";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export async function createEvidencePrivacy(
  stateDirectory: string
): Promise<EvidencePrivacy> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, SALT_FILE);
  try {
    await writeFile(path, randomBytes(SALT_BYTES), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const salt = await readFile(path);
  if (salt.byteLength !== SALT_BYTES) {
    throw new EvidencePrivacyError(
      "INVALID_EVIDENCE_SALT",
      `Evidence salt must contain exactly ${SALT_BYTES} bytes`
    );
  }
  await chmod(path, 0o600);
  return {
    key(namespace, raw) {
      if (raw.length === 0) {
        throw new EvidencePrivacyError(
          "INVALID_EVIDENCE_IDENTIFIER",
          "Evidence identifiers cannot be empty"
        );
      }
      return pseudonymousKeySchema.parse(
        `hmac-sha256:${createHmac("sha256", salt)
          .update(`${namespace}\0${raw}`)
          .digest("hex")}`
      );
    }
  };
}
