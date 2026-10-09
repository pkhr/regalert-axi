/**
 * `doc` and `lineage`: one document. `doc` prints a part of the text by
 * default — a shell tool cuts a long output anyway, and silently — and says
 * how to get the rest; `--query` prints only the passages that match.
 */
import { apiGet } from "../api.js";
import { parseArgs, str, num, type CommandSpec } from "../args.js";
import { UsageError } from "../errors.js";
import { compose, cut, helpBlock, run, shellArg, toon, type Block } from "../output.js";

/** Characters of text a `doc` call prints by default. With the head it stays under the 30,000 that agent shells show. */
export const DEFAULT_MAX_CHARS = 20_000;
const FULL_MAX_CHARS = 400_000;
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DOC: CommandSpec = {
  name: "doc",
  summary: "Read one document: metadata, summary, lineage and the English text (markdown).",
  positionals: [{ name: "uid", required: true, help: "the document's uid, from `search` or `recent`" }],
  flags: {
    query: { kind: "string", value: "words", help: "Print only the passages that hold these words, each with its offset" },
    offset: { kind: "int", help: "Start the text at this character: a passage's offset, or the end of the last part (default 0)" },
    "max-chars": { kind: "int", min: 1000, max: FULL_MAX_CHARS, help: `Most characters of text to print, 1000-${FULL_MAX_CHARS} (default ${DEFAULT_MAX_CHARS}; with --query, 8000)` },
    full: { kind: "boolean", help: "The whole text from --offset on, however long" },
    original: { kind: "boolean", help: "Also the original-language text (not with --query)" },
  },
  renamed: { "--uid": "The uid is the argument: `regalert-axi doc <uid>`", "--grep": 'Use `--query "<words>"`', "--search": 'Use `--query "<words>"`' },
  notes: ["A read counts for fair use; `search`, `recent` and `lineage` do not."],
  examples: ['doc <uid> --query "incident reporting deadline"', "doc <uid>", "doc <uid> --offset 20000", "doc <uid> --full --original"],
};

export const LINEAGE: CommandSpec = {
  name: "lineage",
  summary: "A document's confirmed citation links: what it amends, replaces or is issued under, and what amended or replaced it. No --direction = both.",
  positionals: [{ name: "uid", required: true, help: "the document's uid" }],
  flags: {
    direction: { kind: "string", value: "direction", help: "outgoing = older instruments this document cites; incoming = newer ones that cite it", choices: ["outgoing", "incoming"] },
    relation: { kind: "string", value: "relation", help: "Only one relation", choices: ["amends", "supersedes", "issued_under", "refers"] },
    limit: { kind: "int", min: 1, max: 100, help: "Rows a direction, 1-100 (default 20)" },
    offset: { kind: "int", help: "Rows to skip; needs --direction" },
  },
  examples: ["lineage <uid>", "lineage <uid> --direction incoming --relation amends", "lineage <uid> --direction incoming --offset 20"],
};

function requireUid(command: string, uid: string): string {
  if (!UID.test(uid)) {
    throw new UsageError(`"${uid}" is not a document uid (a UUID such as 8b2890f6-3cf4-435d-bb76-63eae73e4ab3)`, "BAD_UID", [run('search "<words>"', "to find a document and its uid"), run(`${command} --help`)]);
  }
  return uid.toLowerCase();
}

interface LineageDoc {
  uid: string;
  title: string;
  date: string | null;
}
interface Lineage {
  status_label: string;
  cited_by_count: number;
  cites_not_held: Array<{ relation: string; cite: string }>;
  cites_not_held_count: number;
  [key: string]: unknown;
}
interface Passage {
  offset: number;
  heading: string;
  text: string;
}
interface Read {
  document: {
    uid: string;
    title: string;
    identifier: string | null;
    instrument_no: string | null;
    type: string | null;
    published: string | null;
    language: string | null;
    regulator: string | null;
    regulator_name: string | null;
    jurisdiction: string | null;
    topics: string[];
    summary: string | null;
    source: string | null;
    url: string;
    file_url: string | null;
    mode: "text" | "passages";
    text: string;
    text_truncated: boolean;
    text_offset: number;
    text_total_chars: number;
    text_next_offset: number | null;
    original_text_included: boolean;
    original_text: string | null;
    original_text_truncated: boolean;
    original_text_offset: number;
    original_text_total_chars: number;
    passages?: { query: string; terms: string[]; matched: number; shown: number; passages: Passage[] };
    lineage: Lineage;
  };
  charged_usd: string;
  charged_as: string;
}

const LINEAGE_SHOWN = 5;
const LISTS = ["based_on", "amends", "supersedes", "amended_by", "superseded_by"] as const;

function lineageBlock(l: Lineage): { block: Block; more: boolean } {
  const block: Block = { status: l.status_label, cited_by: l.cited_by_count };
  let more = l.cited_by_count > 0;
  for (const name of LISTS) {
    const count = Number(l[`${name}_count`] ?? 0);
    if (!count) continue;
    if (count > LINEAGE_SHOWN) {
      block[`${name}_total`] = count;
      more = true;
    }
    block[name] = ((l[name] as LineageDoc[]) ?? []).slice(0, LINEAGE_SHOWN).map((d) => ({ uid: d.uid, date: d.date, title: cut(d.title, 120) }));
  }
  if (l.cites_not_held_count) {
    if (l.cites_not_held_count > LINEAGE_SHOWN) block.cites_not_held_total = l.cites_not_held_count;
    block.cites_not_held = l.cites_not_held.slice(0, LINEAGE_SHOWN).map((c) => ({ relation: c.relation, cite: cut(c.cite, 160) }));
  }
  return { block, more };
}

export async function docCommand(args: string[]): Promise<string> {
  const { flags: f, positionals } = parseArgs(DOC, args);
  const uid = requireUid("doc", positionals[0]);
  const query = str(f.query);
  if (f.full && f["max-chars"] !== undefined) throw new UsageError("--full and --max-chars cannot be used together", "CONFLICTING_FLAGS", ["--full prints the whole text; --max-chars sets a limit"]);
  if (query && f.original) throw new UsageError("--original cannot be used with --query: passages come from the English text", "CONFLICTING_FLAGS", [run(`doc ${uid} --original`, "for both texts")]);
  if (query && f.offset !== undefined) throw new UsageError("--offset cannot be used with --query: the passages are found in the whole text", "CONFLICTING_FLAGS", [run(`doc ${uid} --offset ${f.offset}`, "to read on from that character")]);
  const maxChars = f.full ? FULL_MAX_CHARS : (num(f["max-chars"]) ?? (query ? undefined : DEFAULT_MAX_CHARS));

  const r = await apiGet<Read>(`/v1/documents/${uid}`, { query, offset: num(f.offset), max_chars: maxChars, include_original: f.original === true });
  const d = r.document;
  const regulator = [d.regulator, d.regulator_name && `— ${d.regulator_name}`, d.jurisdiction && `(${d.jurisdiction})`].filter(Boolean).join(" ");
  const paid = r.charged_usd !== "$0.00" ? { charged: `${r.charged_usd} (${r.charged_as})` } : {};

  if (d.mode === "passages" && d.passages) {
    const p = d.passages;
    const brief: Block = {
      document: { uid: d.uid, title: d.title, published: d.published, regulator, page: d.url },
      lineage: { status: d.lineage.status_label, cited_by: d.lineage.cited_by_count },
      ...paid,
    };
    if (!p.passages.length) {
      return compose(
        toon({ ...brief, passages: `0 passages of this document (${d.text_total_chars} characters) hold the words: ${p.terms.join(", ")}` }),
        helpBlock([run(`doc ${uid} --query "<other words>"`, "- the text is English; use the words the rule would use"), run(`doc ${uid}`, "for summary, lineage and the text from the start")]),
      );
    }
    return compose(
      toon({
        ...brief,
        passages: {
          words: p.terms.join(" "),
          count: `${p.shown} of ${p.matched} total (${p.matched > p.shown ? "the best ones, " : ""}in document order)`,
          of_characters: d.text_total_chars,
        },
      }),
      `--- passages ---\n${p.passages.map((x) => `[offset ${x.offset}${x.heading ? ` · ${cut(x.heading, 160)}` : ""}]\n${x.text}`).join("\n\n")}\n--- end of passages ---`,
      helpBlock([
        run(`doc ${uid} --offset <offset>`, "to read on from a passage"),
        p.matched > p.shown ? run(`doc ${uid} --query ${shellArg(p.query)} --max-chars 20000`, `for more of the ${p.matched} passages`) : "",
        run(`doc ${uid}`, "for summary, lineage and the text from the start"),
      ]),
    );
  }

  const { block: lineage, more } = lineageBlock(d.lineage);
  const end = d.text_offset + d.text.length;
  const hasOriginal = d.original_text_total_chars > 0 && !!d.language && d.language !== "en";
  const originalEnd = d.original_text_offset + (d.original_text ?? "").length;
  return compose(
    toon({
      document: {
        uid: d.uid,
        title: d.title,
        identifier: d.identifier ?? undefined,
        instrument_no: d.instrument_no ?? undefined,
        type: d.type ?? undefined,
        published: d.published,
        regulator,
        original_language: d.language ?? undefined,
        topics: d.topics.length ? d.topics.join(" ") : undefined,
        source: d.source ?? undefined,
        page: d.url,
        file: d.file_url ?? undefined,
      },
      summary: d.summary ?? undefined,
      lineage,
      ...paid,
      text: d.text_total_chars
        ? `characters ${d.text_offset}-${end} of ${d.text_total_chars}${d.text_truncated ? " (truncated)" : ""}`
        : "0 characters: this document has no English text",
      original: hasOriginal && !d.original_text_included ? `${d.original_text_total_chars} characters in "${d.language}", not shown` : undefined,
    }),
    d.text ? `--- text ---\n${d.text}\n--- end of ${d.text_truncated ? `part: ${end} of ${d.text_total_chars} characters` : "text"} ---` : "",
    d.original_text_included && d.original_text
      ? `--- original text (${d.language ?? "source language"}) ---\n${d.original_text}\n--- end of ${d.original_text_truncated ? `part: ${originalEnd} of ${d.original_text_total_chars} characters` : "original text"} ---`
      : "",
    helpBlock([
      d.text_truncated ? run(`doc ${uid} --offset ${d.text_next_offset}${f.original ? " --original" : ""}`, "for the next part") : "",
      d.text_truncated ? run(`doc ${uid} --full${d.text_offset ? ` --offset ${d.text_offset}` : ""}`, `for the whole text (${d.text_total_chars} characters)`) : "",
      d.text_total_chars > 8_000 ? run(`doc ${uid} --query "<words>"`, "for only the passages that match") : "",
      hasOriginal && !d.original_text_included ? run(`doc ${uid} --original`, "to add the source-language text") : "",
      more ? run(`lineage ${uid}`, "for every document that cites, amends or replaces this one") : "",
    ]),
  );
}

interface Edge {
  relation: string;
  uid: string | null;
  title: string | null;
  regulator: string | null;
  date: string | null;
  cite: string | null;
}
interface Page {
  edges: Edge[];
  total: number;
  offset: number;
  has_more: boolean;
}

const MEANS = { outgoing: "older instruments this document cites", incoming: "newer instruments that cite this document" } as const;
type Direction = keyof typeof MEANS;

function directionBlock(direction: Direction, page: Page): Block {
  const held = page.edges.filter((e) => e.uid);
  const notHeld = page.edges.filter((e) => !e.uid && e.cite);
  if (!page.edges.length) {
    return { [direction]: page.total ? `0 links from offset ${page.offset}: there are ${page.total} in all` : `0 confirmed links (${MEANS[direction]})` };
  }
  return {
    [direction]: `${page.offset + 1}-${page.offset + page.edges.length} of ${page.total} total (${MEANS[direction]})`,
    ...(held.length ? { [`${direction}_documents`]: held.map((e) => ({ relation: e.relation, uid: e.uid, date: e.date, regulator: e.regulator, title: cut(e.title ?? "", 120) })) } : {}),
    ...(notHeld.length ? { [`${direction}_not_in_corpus`]: notHeld.map((e) => ({ relation: e.relation, cite: cut(e.cite ?? "", 160) })) } : {}),
  };
}

export async function lineageCommand(args: string[]): Promise<string> {
  const { flags: f, positionals } = parseArgs(LINEAGE, args);
  const uid = requireUid("lineage", positionals[0]);
  const direction = str(f.direction) as Direction | undefined;
  const relation = str(f.relation);
  const limit = num(f.limit);
  if (!direction && f.offset !== undefined) {
    throw new UsageError("--offset needs --direction: the two directions are paged apart", "CONFLICTING_FLAGS", [run(`lineage ${uid} --direction incoming --offset ${f.offset}`)]);
  }
  const directions: Direction[] = direction ? [direction] : ["incoming", "outgoing"];
  const pages = await Promise.all(directions.map((dir) => apiGet<Page>(`/v1/documents/${uid}/lineage`, { direction: dir, relation, limit, offset: num(f.offset) })));

  const tail = `${relation ? ` --relation ${relation}` : ""}${limit ? ` --limit ${limit}` : ""}`;
  return compose(
    toon({ uid, relation: relation ?? "all", ...Object.assign({}, ...directions.map((dir, i) => directionBlock(dir, pages[i]))) }),
    helpBlock([
      ...directions.map((dir, i) => {
        const p = pages[i];
        const last = p.offset + p.edges.length;
        return p.has_more ? run(`lineage ${uid} --direction ${dir}${tail} --offset ${last}`, `for the next ${Math.min(limit ?? 20, p.total - last)} ${dir} links`) : "";
      }),
      pages.some((p) => p.edges.some((e) => e.uid)) ? run("doc <uid>", "to read one of them") : "",
      relation && pages.every((p) => !p.total) ? run(`lineage ${uid}`, "for every relation") : "",
    ]),
  );
}
