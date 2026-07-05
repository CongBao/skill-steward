import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bindIntegrationDirectoryChain } from "../src/integration-file-proof.js";

it("binds a stable directory identity while unrelated lease entries churn", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "steward-directory-proof-churn-"));
  const target = join(boundary, "target.json");
  let stop = false;
  const churn = (async () => {
    let index = 0;
    while (!stop) {
      const path = join(boundary, `.lease-churn-${index++}`);
      await writeFile(path, "lease\n", { mode: 0o600 });
      await unlink(path);
    }
  })();

  try {
    await expect(Promise.all(Array.from({ length: 100 }, () =>
      bindIntegrationDirectoryChain(boundary, target)
    ))).resolves.toHaveLength(100);
  } finally {
    stop = true;
    await churn;
  }
});
