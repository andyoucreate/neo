import { createRequire } from "node:module";
import { defineCommand } from "citty";

const require = createRequire(import.meta.url);

interface PackageJson {
  version: string;
}

export default defineCommand({
  meta: {
    name: "version",
    description: "Print the neo CLI version",
  },
  run() {
    const pkg = require("../../package.json") as PackageJson;
    console.log(pkg.version);
  },
});
