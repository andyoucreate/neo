import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { resolveAgentsPackageDir } from "../resolve.js";

export default defineCommand({
  meta: {
    name: "guide",
    description: "Print the AI integration guide for using neo",
  },
  async run() {
    const guidePath = path.join(resolveAgentsPackageDir(), "GUIDE.md");
    const content = await readFile(guidePath, "utf-8");
    console.log(content);
  },
});
