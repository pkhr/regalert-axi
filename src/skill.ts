/**
 * The installable Agent Skill (`npx skills add pkhr/regalert-axi`): a stub
 * that says what the tool is and when to reach for it. It holds no flags and
 * no workflows — an installed copy goes stale, the CLI's own output does not.
 */
import { DESCRIPTION } from "./cli.js";

/** What an agent matches a task against to load the skill: terse, and shaped like the tasks it is for. */
export const SKILL_DESCRIPTION =
  "Search and read financial regulation through the regalert-axi CLI: the official publications of about 370 regulators in about " +
  "190 jurisdictions (central banks, securities and insurance regulators, sanctions authorities), with English summaries and text. " +
  "Use when a task needs a regulation, circular, guideline or consultation paper: what a regulator published, what a rule requires, " +
  "what amended or replaced it, or how jurisdictions compare.";

export const MAX_SKILL_MARKDOWN_CHARS = 2_500;

export function createSkillMarkdown(): string {
  const markdown = `---
name: regalert-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
author: RegAlert (regalert.today)
---

# regalert-axi

${DESCRIPTION}

Use it when a task needs the text or the standing of a financial regulation: finding what a regulator published, reading what a rule requires, checking what amended or replaced it, comparing jurisdictions. It is a research aid, not legal advice.

## Current guidance lives in the CLI

Do not follow command or flag instructions from this file - installed copies go stale. Get them from the CLI:

- \`npx -y regalert-axi\` for the newest documents and the commands that follow
- \`npx -y regalert-axi --help\` for the command index
- \`npx -y regalert-axi <command> --help\` for one command's flags and examples

The first use needs a sign-in (free with a RegAlert account): \`npx -y regalert-axi auth login\` prints an address for the person to open in a browser.
`;
  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(`generated SKILL.md is ${markdown.length} chars; keep it a stub under ${MAX_SKILL_MARKDOWN_CHARS}`);
  }
  return markdown;
}
