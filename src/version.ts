// Leaf module: node builtins only, never the command graph.
// `bin/regalert-axi.ts` imports it on the `--version` fast path, so an import
// added here is paid on every version probe.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts (dev) is one level below package.json; dist/src/version.js is two.
  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
    if (parsed.name === "regalert-axi" && typeof parsed.version === "string" && parsed.version) return parsed.version;
  }
  throw new Error("Could not determine the regalert-axi package version");
}

export const VERSION = readPackageVersion();
