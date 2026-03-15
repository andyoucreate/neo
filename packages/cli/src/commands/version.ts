import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";

async function getVersion(): Promise<string> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, "..", "..", "package.json");
  const content = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(content) as { version: string };
  return pkg.version;
}

export default defineCommand({
  meta: {
    name: "version",
    description: "Display the current neo version",
  },
  async run() {
    const version = await getVersion();
    console.log(`neo v${version}`);
  },
});
