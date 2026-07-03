import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InstallerError } from "./domain.js";

export interface StagedPreview {
  id: string;
  directory: string;
  createdAt: number;
  expiresAt: number;
}

export interface StagingRegistryOptions {
  stateDirectory: string;
  now?: () => number;
  id?: () => string;
}

export class StagingRegistry {
  readonly #root: string;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #previews = new Map<string, StagedPreview>();

  constructor(options: StagingRegistryOptions) {
    this.#root = resolve(options.stateDirectory, "staging");
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  async create({ ttlMs }: { ttlMs: number }): Promise<StagedPreview> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new InstallerError("INVALID_TTL", "Preview TTL must be a positive integer");
    }
    const id = this.#id();
    const createdAt = this.#now();
    const preview = {
      id,
      directory: join(this.#root, id),
      createdAt,
      expiresAt: createdAt + ttlMs
    };
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await mkdir(preview.directory, { recursive: false, mode: 0o700 });
    this.#previews.set(id, preview);
    return preview;
  }

  async resolve(id: string): Promise<StagedPreview> {
    const preview = this.#previews.get(id);
    if (!preview) {
      throw new InstallerError("PREVIEW_NOT_FOUND", "Installation preview was not found");
    }
    if (this.#now() > preview.expiresAt) {
      await this.expire(id);
      throw new InstallerError("PREVIEW_EXPIRED", "Installation preview has expired");
    }
    return preview;
  }

  async expire(id: string): Promise<void> {
    const preview = this.#previews.get(id);
    if (!preview) return;
    this.#previews.delete(id);
    await rm(preview.directory, { recursive: true, force: true });
  }
}
