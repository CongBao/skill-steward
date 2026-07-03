import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEvidencePrivacy,
  EvidencePrivacyError
} from "../src/evidence-privacy.js";

describe("evidence privacy", () => {
  it("creates a private salt and stable namespace-separated HMAC keys", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-salt-"));
    const privacy = await createEvidencePrivacy(state);
    const first = privacy.key("session", "private-session-id");
    expect(first).toBe(privacy.key("session", "private-session-id"));
    expect(first).not.toBe(privacy.key("turn", "private-session-id"));
    expect(first).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain("private-session-id");
    const saltPath = join(state, "evidence-salt");
    expect((await readFile(saltPath)).byteLength).toBe(32);
    expect((await stat(saltPath)).mode & 0o777).toBe(0o600);

    const reopened = await createEvidencePrivacy(state);
    expect(reopened.key("session", "private-session-id")).toBe(first);
  });

  it("rejects an invalid existing salt", async () => {
    const state = await mkdtemp(join(tmpdir(), "steward-salt-invalid-"));
    await writeFile(join(state, "evidence-salt"), "too-short", { mode: 0o600 });
    await expect(createEvidencePrivacy(state)).rejects.toBeInstanceOf(EvidencePrivacyError);
  });
});
