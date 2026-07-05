import { describe, expect, it, vi } from "vitest";
import { createIntegrationOperationGuard } from "./integrationOperationState.js";

describe("integration operation guard", () => {
  it("blocks conflicts synchronously and rejects a late response token", () => {
    const guard = createIntegrationOperationGuard();
    const first = guard.begin("reviewing");
    expect(first).not.toBeNull();
    expect(guard.begin("applying")).toBeNull();
    expect(guard.state()).toBe("reviewing");

    expect(guard.finish(first!)).toBe(true);
    const second = guard.begin("reviewing");
    expect(second).not.toBeNull();
    const staleCommit = vi.fn();
    const currentCommit = vi.fn();

    expect(guard.commit(first!, staleCommit)).toBe(false);
    expect(staleCommit).not.toHaveBeenCalled();
    expect(guard.commit(second!, currentCommit)).toBe(true);
    expect(currentCommit).toHaveBeenCalledOnce();
  });
});
