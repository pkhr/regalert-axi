import { describe, expect, it } from "vitest";

import { helpFor, parseArgs, type CommandSpec } from "../src/args.js";
import { UsageError } from "../src/errors.js";

const SPEC: CommandSpec = {
  name: "search",
  summary: "Search the documents.",
  positionals: [{ name: "words", required: true, variadic: true, help: "the words" }],
  flags: {
    regulator: { kind: "string", value: "code", help: "Regulator code" },
    sort: { kind: "string", value: "order", help: "Order", choices: ["relevance", "newest"] },
    limit: { kind: "int", help: "Rows" },
    all: { kind: "boolean", help: "Everything" },
    secret: { kind: "boolean", help: "Internal", hidden: true },
  },
  renamed: { "--country": "Use `--jurisdiction <code>`" },
  examples: ['search "capital" --regulator CBN'],
};

const ONE: CommandSpec = { name: "doc", summary: "Read.", positionals: [{ name: "uid", required: true, help: "the uid" }], flags: {}, examples: ["doc <uid>"] };

function fail(fn: () => unknown): UsageError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error("expected a UsageError");
}

describe("parseArgs", () => {
  it("takes --flag value and --flag=value, in any place among the words", () => {
    expect(parseArgs(SPEC, ["capital", "--regulator", "CBN", "adequacy", "--limit=5", "--all"])).toEqual({
      flags: { regulator: "CBN", limit: 5, all: true },
      positionals: ["capital", "adequacy"],
    });
  });

  it("after -- everything is a word, also what looks like a flag", () => {
    expect(parseArgs(SPEC, ["--", "--limit", "5"]).positionals).toEqual(["--limit", "5"]);
  });

  it("refuses an unknown flag by name and lists the valid ones; a hidden flag is not listed", () => {
    const e = fail(() => parseArgs(SPEC, ["capital", "--regulater", "CBN"]));
    expect(e.code).toBe("UNKNOWN_FLAG");
    expect(e.message).toBe("unknown flag --regulater for `search`");
    expect(e.suggestions[0]).toBe("valid flags for `search`: --regulator, --sort, --limit, --all (--help always allowed)");
    expect(fail(() => parseArgs(SPEC, ["capital", "-x"])).message).toBe("unknown flag -x for `search`");
    expect(fail(() => parseArgs(SPEC, ["capital", "--regulater=CBN"])).message).toBe("unknown flag --regulater for `search`");
  });

  it("a flag that has another name here gets that name, before the list", () => {
    const e = fail(() => parseArgs(SPEC, ["capital", "--country", "NG"]));
    expect(e.suggestions[0]).toBe("Use `--jurisdiction <code>`");
    expect(e.suggestions[1]).toMatch(/^valid flags for `search`/);
  });

  it("a flag with no value is an error, and the next flag is not taken as its value", () => {
    expect(fail(() => parseArgs(SPEC, ["capital", "--regulator"])).code).toBe("MISSING_VALUE");
    expect(fail(() => parseArgs(SPEC, ["capital", "--regulator", "--limit", "5"])).code).toBe("MISSING_VALUE");
    expect(fail(() => parseArgs(SPEC, ["capital", "--regulator="])).code).toBe("MISSING_VALUE");
  });

  it("checks a number, a choice, a boolean with a value and a flag given twice", () => {
    expect(fail(() => parseArgs(SPEC, ["capital", "--limit", "ten"])).code).toBe("BAD_VALUE");
    expect(fail(() => parseArgs(SPEC, ["capital", "--limit", "-5"])).code).toBe("BAD_VALUE");
    expect(fail(() => parseArgs(SPEC, ["capital", "--sort", "oldest"])).message).toBe('--sort must be one of relevance, newest; got "oldest"');
    expect(fail(() => parseArgs(SPEC, ["capital", "--all=true"])).code).toBe("BAD_VALUE");
    expect(fail(() => parseArgs(SPEC, ["capital", "--limit", "1", "--limit", "2"])).code).toBe("DUPLICATE_FLAG");
  });

  it("a missing argument names it and shows the usage; an extra one is refused", () => {
    const missing = fail(() => parseArgs(SPEC, ["--limit", "5"]));
    expect(missing.code).toBe("MISSING_ARGUMENT");
    expect(missing.suggestions[0]).toBe("usage: regalert-axi search <words…> [flags]");
    const extra = fail(() => parseArgs(ONE, ["a", "b"]));
    expect(extra.code).toBe("UNEXPECTED_ARGUMENT");
    expect(extra.message).toBe('unexpected argument "b" for `doc`');
  });
});

describe("helpFor", () => {
  it("is printed from the same declaration the parser reads: usage, arguments, flags, examples", () => {
    expect(helpFor(SPEC)).toBe(
      [
        "usage: regalert-axi search <words…> [flags]",
        "Search the documents.",
        "arguments[1]:",
        "  words: the words",
        "flags[4]:",
        "  --regulator <code>: Regulator code",
        "  --sort <order>: Order (relevance | newest)",
        "  --limit <n>: Rows",
        "  --all: Everything",
        "examples[1]:",
        '  regalert-axi search "capital" --regulator CBN',
        "",
      ].join("\n"),
    );
  });

  it("a command with no flags says so in its usage line", () => {
    expect(helpFor(ONE).split("\n")[0]).toBe("usage: regalert-axi doc <uid>");
  });
});
