/**
 * The command table and the two boundaries every command passes: arguments
 * in (args.ts, strict) and text out (TOON on stdout, errors in the same
 * form). `runAxiCli` from the AXI SDK does the dispatch, `--help`,
 * `--version` and the built-in `update`.
 */
import { runAxiCli } from "axi-sdk-js";
import { offersObligations } from "./api.js";
import { helpFor, type CommandSpec } from "./args.js";
import { ACCOUNT, accountCommand, authCommand } from "./commands/auth.js";
import { REGULATORS, regulatorsCommand, TOPICS, topicsCommand } from "./commands/catalog.js";
import { DOC, docCommand, LINEAGE, lineageCommand } from "./commands/doc.js";
import { RECENT, recentCommand, SEARCH, searchCommand } from "./commands/documents.js";
import { homeCommand } from "./commands/home.js";
import { OBLIGATIONS, obligationsCommand, SIMILAR, similarCommand } from "./commands/obligations.js";
import { setupCommand } from "./commands/setup.js";
import { knownRoutes } from "./config.js";
import { AxiError, CliError, exitCodeFor, UsageError } from "./errors.js";
import { BIN, compose, helpBlock, run, toon } from "./output.js";
import { VERSION } from "./version.js";

// No colon and no comma-led clause that would make the encoder quote it: this line opens every home view.
export const DESCRIPTION =
  "Search and read the official publications of about 370 financial regulators worldwide (RegAlert) with English summaries and text";

type Handler = (args: string[]) => Promise<string>;

const SPECS: Record<string, CommandSpec> = {
  search: SEARCH,
  recent: RECENT,
  doc: DOC,
  lineage: LINEAGE,
  regulators: REGULATORS,
  topics: TOPICS,
  obligations: OBLIGATIONS,
  similar: SIMILAR,
  account: ACCOUNT,
};

const COMMANDS: Record<string, Handler> = {
  search: searchCommand,
  recent: recentCommand,
  doc: docCommand,
  lineage: lineageCommand,
  regulators: regulatorsCommand,
  topics: topicsCommand,
  obligations: obligationsCommand,
  similar: similarCommand,
  account: accountCommand,
  auth: authCommand,
  setup: setupCommand,
};

/** `--help`: every command in one line each. The two that depend on the server are listed when it offers them. */
export function topLevelHelp(obligations = offersObligations(knownRoutes())): string {
  const rows: Array<[string, string]> = [
    ["(none)", "the newest documents and what to run next"],
    ['search "<words>"', "search the documents by words; --regulator, --jurisdiction, --region, --topic, --sort, --limit, --fields"],
    ["recent", "what was published, newest first; the same filters, --since, --until, --offset"],
    ["doc <uid>", 'read one document; --query "<words>" for only the matching passages, --offset, --full, --original'],
    ["lineage <uid>", "what a document amends or replaces, and what amended or replaced it"],
    ["regulators", "the regulators and their codes; --region, --jurisdiction, --query"],
    ["topics", "the topic tags"],
    ...(obligations
      ? ([
          ['obligations "<words>"', "the rule sentences that state a duty, found by meaning"],
          ["similar <id>", "the same kind of duty in other jurisdictions"],
        ] as Array<[string, string]>)
      : []),
    ["account", "this account's access"],
    ["auth login|status|logout", "sign in (free with a RegAlert account)"],
    ["setup hooks", "show the home view at the start of every agent session"],
  ];
  return [
    `usage: ${BIN} [command] [args] [flags]`,
    `description: ${DESCRIPTION}`,
    `commands[${rows.length}]:`,
    ...rows.map(([name, what]) => `  ${name}: ${what}`),
    "flags[2]:",
    "  --help: after a command, its flags and examples",
    "  -v, -V, --version: the version",
    "environment[2]:",
    "  REGALERT_TOKEN: a bearer token; no sign-in is then needed",
    "  REGALERT_API_URL: another server (default https://mcp.regalert.today)",
    "examples[4]:",
    `  ${BIN}`,
    `  ${BIN} search "capital adequacy" --regulator CBN`,
    `  ${BIN} doc <uid> --query "incident reporting deadline"`,
    `  ${BIN} recent --jurisdiction SG --since 2026-09-01`,
    "",
  ].join("\n");
}

/** An error as the agent reads it: the sentence, the code, rows that belong to it, and the commands that fix it. */
export function formatError(error: unknown): { output: string; exitCode: number } {
  const e =
    error instanceof AxiError
      ? error
      : new CliError(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`, "INTERNAL_ERROR", ["Run the same command again; if it fails again, report it at https://github.com/pkhr/regalert-axi/issues"]);
  const details = e instanceof CliError ? e.details : {};
  return {
    output: `${compose(toon({ error: e.message, code: e.code, ...details }), helpBlock(e.suggestions))}\n`,
    exitCode: exitCodeFor(e),
  };
}

/** How many single-character edits turn `a` into `b`: a mistyped command is one or two away from the real one. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

const TEMPLATE: Record<string, string> = { search: 'search "<words>"', doc: "doc <uid>", lineage: "lineage <uid>", obligations: 'obligations "<words>"', similar: "similar <id>", auth: "auth login", setup: "setup hooks" };

function unknownCommand(command: string): string {
  // The two commands that depend on the server are named only when it offers them.
  const offered = offersObligations(knownRoutes());
  const names = Object.keys(COMMANDS).filter((n) => offered || (n !== "obligations" && n !== "similar"));
  const near = names
    .map((n) => ({ n, d: editDistance(command.toLowerCase(), n) }))
    .filter((x) => x.d <= 2 || x.n.startsWith(command.toLowerCase()))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2);
  return `${compose(
    toon({ error: `unknown command \`${command}\``, code: "UNKNOWN_COMMAND" }),
    helpBlock([...near.map((x) => run(TEMPLATE[x.n] ?? x.n)), `commands: ${names.join(", ")}`, run("--help", "for what each one does")]),
  )}\n`;
}

const ALONE = new Set(["--help", "-v", "-V", "--version"]);

export async function main(options: { argv?: string[]; stdout?: { write: (chunk: string) => unknown } } = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  // A flag in front of the command: said in this tool's own error form, with the command as it should be typed.
  if (argv[0]?.startsWith("-") && !(argv.length === 1 && ALONE.has(argv[0]))) {
    const command = argv.find((a) => a in COMMANDS);
    const fixed = command ? [command, ...argv.filter((a) => a !== command)].join(" ") : "<command> [args] [flags]";
    const formatted = formatError(new UsageError(`flags come after the command; got \`${argv[0]}\` first`, "FLAG_BEFORE_COMMAND", [run(fixed), run("--help", "for the commands")]));
    stdout.write(formatted.output);
    process.exitCode = formatted.exitCode;
    return;
  }
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    packageName: BIN,
    argv,
    stdout: options.stdout,
    topLevelHelp: topLevelHelp(),
    home: homeCommand,
    commands: COMMANDS,
    // `auth` and `setup` print their own help: it depends on the sub-command.
    getCommandHelp: (command) => (SPECS[command] ? helpFor(SPECS[command]) : undefined),
    renderUnknownCommand: unknownCommand,
    formatError,
  });
}
