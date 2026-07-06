import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@skill-steward/integrations": fileURLToPath(
        new URL("../integrations/src/index.ts", import.meta.url)
      ),
      "@skill-steward/store": fileURLToPath(
        new URL("../store/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    maxWorkers: 1
  }
});
