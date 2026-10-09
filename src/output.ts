/**
 * The output boundary: TOON on stdout. Commands build plain objects; this
 * file turns them into text. `help[n]:` lines are written by hand — a command
 * template holds backticks, quotes and "<…>", and the encoder would escape
 * each of them.
 */
import { encode } from "@toon-format/toon";

export const BIN = "regalert-axi";

export type Block = Record<string, unknown>;

/** Drop keys with no value, at every depth: "not asked for" must not print as null. */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Block)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, clean(v)]),
    );
  }
  return value;
}

export function toon(value: Block): string {
  return encode(clean(value) as Block);
}

/** "Run `regalert-axi <command>` <why>": one next step, as a complete command. */
export function run(command: string, why = ""): string {
  return `Run \`${BIN}${command ? ` ${command}` : ""}\`${why ? ` ${why}` : ""}`;
}

export function helpBlock(lines: Array<string | false | null | undefined>): string {
  const shown = lines.filter((l): l is string => typeof l === "string" && l !== "");
  if (!shown.length) return "";
  return `help[${shown.length}]:\n${shown.map((l) => `  ${l}`).join("\n")}`;
}

/** Parts of one answer, top to bottom; empty parts are left out. */
export function compose(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n");
}

/** A flag value as it must be typed in a shell: quoted when it holds a space or a shell character. */
export function shellArg(value: string | number): string {
  const s = String(value);
  return /^[A-Za-z0-9_.,:=@/+-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `--flag value` pairs for a suggested command, in the order given; empty values are left out. */
export function flags(pairs: Record<string, string | number | boolean | undefined | null>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
    .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${shellArg(v as string | number)}`))
    .join(" ");
}

/** `key=value` pairs of the filters that were applied: the echo line of a list. */
export function pairs(args: Record<string, string | number | undefined | null>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
