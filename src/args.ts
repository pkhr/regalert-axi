/**
 * Strict arguments. Every command declares its flags and its positional
 * arguments; anything else is refused by name, with the valid flags in the
 * error. A silently dropped flag is worse than an error: the agent gets
 * output it believes is filtered, and goes on with the wrong data.
 *
 * The same declaration prints the command's `--help`, so the help cannot
 * name a flag the parser does not know, or miss one it does.
 */
import { UsageError } from "./errors.js";
import { BIN, run } from "./output.js";

export interface FlagSpec {
  /** "string" and "int" take a value; "boolean" does not. */
  kind: "string" | "int" | "boolean";
  /** The value's name in the help: `--limit <n>`. */
  value?: string;
  help: string;
  choices?: readonly string[];
  /** For "int": the smallest and the largest value taken. A value outside is refused, not clamped. */
  min?: number;
  max?: number;
  /** Not shown in the help (internal use). */
  hidden?: boolean;
}

export interface PositionalSpec {
  name: string;
  help: string;
  required?: boolean;
  /** Takes every remaining word: `search capital adequacy` needs no quotes. */
  variadic?: boolean;
}

export interface CommandSpec {
  /** As typed after the binary: "search", "auth login". */
  name: string;
  summary: string;
  flags: Record<string, FlagSpec>;
  positionals?: PositionalSpec[];
  examples: string[];
  /** A flag people try that has another name here → what to use. */
  renamed?: Record<string, string>;
  /** Extra lines for the help. */
  notes?: string[];
}

export interface Parsed {
  flags: Record<string, string | number | boolean | undefined>;
  positionals: string[];
}

const usageLine = (spec: CommandSpec): string => {
  const pos = (spec.positionals ?? []).map((p) => (p.required ? `<${p.name}${p.variadic ? "…" : ""}>` : `[${p.name}${p.variadic ? "…" : ""}]`));
  const hasFlags = Object.values(spec.flags).some((f) => !f.hidden);
  return [BIN, spec.name, ...pos, hasFlags ? "[flags]" : ""].filter(Boolean).join(" ");
};

const flagLabel = (name: string, f: FlagSpec): string =>
  f.kind === "boolean" ? `--${name}` : `--${name} <${f.value ?? (f.kind === "int" ? "n" : "value")}>`;

/** The concise reference of one command: usage, arguments, flags with their defaults, examples. */
export function helpFor(spec: CommandSpec): string {
  const lines = [`usage: ${usageLine(spec)}`, spec.summary];
  const pos = spec.positionals ?? [];
  if (pos.length) {
    lines.push(`arguments[${pos.length}]:`);
    for (const p of pos) lines.push(`  ${p.name}${p.required ? "" : " (optional)"}: ${p.help}`);
  }
  const shown = Object.entries(spec.flags).filter(([, f]) => !f.hidden);
  if (shown.length) {
    lines.push(`flags[${shown.length}]:`);
    for (const [name, f] of shown) lines.push(`  ${flagLabel(name, f)}: ${f.help}${f.choices ? ` (${f.choices.join(" | ")})` : ""}`);
  }
  for (const note of spec.notes ?? []) lines.push(note);
  lines.push(`examples[${spec.examples.length}]:`);
  for (const e of spec.examples) lines.push(`  ${BIN} ${e}`);
  return `${lines.join("\n")}\n`;
}

const validFlags = (spec: CommandSpec): string => {
  const names = Object.entries(spec.flags)
    .filter(([, f]) => !f.hidden)
    .map(([n]) => `--${n}`);
  return `valid flags for \`${spec.name}\`: ${names.length ? names.join(", ") : "(none)"} (--help always allowed)`;
};

export function parseArgs(spec: CommandSpec, args: string[]): Parsed {
  const flags: Parsed["flags"] = {};
  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (onlyPositionals || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositionals = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--?/, "");
    const flag = arg.startsWith("--") ? spec.flags[name] : undefined;
    if (!flag) {
      const shown = eq === -1 ? arg : arg.slice(0, eq);
      const renamed = spec.renamed?.[shown];
      throw new UsageError(
        `unknown flag ${shown} for \`${spec.name}\``,
        "UNKNOWN_FLAG",
        renamed ? [renamed, validFlags(spec)] : [validFlags(spec), run(`${spec.name} --help`, "for what each flag does")],
      );
    }
    if (name in flags) throw new UsageError(`--${name} is given more than once`, "DUPLICATE_FLAG", [validFlags(spec)]);

    if (flag.kind === "boolean") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value; got "${arg}"`, "BAD_VALUE", [`Use \`--${name}\` alone`]);
      flags[name] = true;
      continue;
    }

    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      const next = args[i + 1];
      // A following flag is a missing value, not a value: `--regulator --limit 5`.
      if (next !== undefined && !(next.startsWith("--") && next.length > 2)) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value.trim() === "") {
      throw new UsageError(`${flagLabel(name, flag)} needs a value`, "MISSING_VALUE", [`${flagLabel(name, flag)}: ${flag.help}`]);
    }
    if (flag.choices && !flag.choices.includes(value)) {
      throw new UsageError(`--${name} must be one of ${flag.choices.join(", ")}; got "${value}"`, "BAD_VALUE");
    }
    if (flag.kind === "int") {
      if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number, 0 or more; got "${value}"`, "BAD_VALUE");
      const n = Number(value);
      // Out of range is said, not clamped: `--limit 500` that quietly became 50 would look like "that is all there is".
      if ((flag.min !== undefined && n < flag.min) || (flag.max !== undefined && n > flag.max)) {
        throw new UsageError(`--${name} must be from ${flag.min ?? 0} to ${flag.max ?? "any number"}; got ${value}`, "BAD_VALUE", [`${flagLabel(name, flag)}: ${flag.help}`]);
      }
      flags[name] = n;
    } else {
      flags[name] = value;
    }
  }

  const specs = spec.positionals ?? [];
  const required = specs.filter((p) => p.required).length;
  if (positionals.length < required) {
    const missing = specs[positionals.length];
    throw new UsageError(`\`${spec.name}\` needs <${missing.name}>: ${missing.help}`, "MISSING_ARGUMENT", [`usage: ${usageLine(spec)}`, ...spec.examples.slice(0, 1).map((e) => `example: ${BIN} ${e}`)]);
  }
  const variadic = specs.some((p) => p.variadic);
  if (!variadic && positionals.length > specs.length) {
    const extra = positionals.slice(specs.length);
    throw new UsageError(
      `unexpected argument${extra.length > 1 ? "s" : ""} ${extra.map((e) => `"${e}"`).join(", ")} for \`${spec.name}\``,
      "UNEXPECTED_ARGUMENT",
      [`usage: ${usageLine(spec)}`, "A value with spaces needs quotes"],
    );
  }
  return { flags, positionals };
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
