// Writes skills/regalert-axi/SKILL.md from src/skill.ts.
//
//   npm run build:skill   # write the file
//   npm run check:skill   # exit 1 when the committed file is stale (CI runs this)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createSkillMarkdown } from "../src/skill.js";

const target = new URL("../skills/regalert-axi/SKILL.md", import.meta.url);
const expected = createSkillMarkdown();

if (process.argv.includes("--check")) {
  const actual = await readFile(target, "utf8").catch(() => null);
  if (actual !== expected) {
    console.error("skills/regalert-axi/SKILL.md is out of date. Run `npm run build:skill` and commit the result.");
    process.exit(1);
  }
  console.log("skills/regalert-axi/SKILL.md is up to date.");
} else {
  await mkdir(new URL("../skills/regalert-axi/", import.meta.url), { recursive: true });
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
