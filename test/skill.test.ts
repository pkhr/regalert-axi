import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createSkillMarkdown, MAX_SKILL_MARKDOWN_CHARS } from "../src/skill.js";

describe("the installable skill", () => {
  it("the committed SKILL.md is what the source generates (run `npm run build:skill` after a change)", () => {
    expect(readFileSync(new URL("../skills/regalert-axi/SKILL.md", import.meta.url), "utf8")).toBe(createSkillMarkdown());
  });

  it("is a stub that points at the CLI: a trigger, no flags, commands that need no install", () => {
    const md = createSkillMarkdown();
    expect(md).toMatch(/^---\nname: regalert-axi\ndescription: ".+"\nuser-invocable: false\n/);
    expect(md.length).toBeLessThan(MAX_SKILL_MARKDOWN_CHARS);
    expect(md).toContain("`npx -y regalert-axi`");
    expect(md).toContain("`npx -y regalert-axi <command> --help`");
    // flags live in the CLI's own help, where they cannot go stale
    expect(md).not.toMatch(/--(regulator|jurisdiction|query|limit)\b/);
  });
});
