import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "packages/core/src"),
    },
  },
  test: {
    include: ["**/*.e2e.test.ts"],
    testTimeout: 60000,
    setupFiles: ["packages/core/src/__tests__/fixtures/e2e-setup.ts"],
    passWithNoTests: true,
  },
});
