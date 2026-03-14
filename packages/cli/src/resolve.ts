import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function resolvePackageDir(pkg: string): string {
  const pkgPath = require.resolve(`${pkg}/package.json`);
  return path.dirname(pkgPath);
}

export function resolveAgentsDir(): string {
  return path.join(resolvePackageDir("@neotx/agents"), "agents");
}
