import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "daemon/worker": "src/daemon/worker.ts",
    "daemon/supervisor-worker": "src/daemon/supervisor-worker.ts",
  },
  format: ["esm"],
  target: "es2022",
  clean: true,
  sourcemap: true,
  external: ["@neotx/core", "better-sqlite3", "sqlite-vec", "@huggingface/transformers"],
  esbuildOptions(options) {
    options.banner = {
      // Only add shebang to the CLI entry, not the worker
      js: "",
    };
  },
  async onSuccess() {
    // Prepend shebang to index.js only
    const { readFileSync, writeFileSync } = await import("node:fs");
    const indexPath = new URL("dist/index.js", `file://${process.cwd()}/`).pathname;
    const content = readFileSync(indexPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(indexPath, `#!/usr/bin/env node\n${content}`);
    }
  },
});
