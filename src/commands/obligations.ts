/**
 * `obligations` and `similar`: the sentences that state what a firm must,
 * must not or may do, found by meaning. The feature is switched on per
 * server; the commands are listed only when the server offers their routes.
 */
import { apiGet } from "../api.js";
import { parseArgs, str, num, type CommandSpec } from "../args.js";
import { compose, cut, helpBlock, pairs, run, shellArg, toon } from "../output.js";

const CATEGORIES = ["obligation", "prohibition", "permission", "scope", "timing", "replaces", "definition", "regulator_action", "any"] as const;

export const OBLIGATIONS: CommandSpec = {
  name: "obligations",
  summary: "Find the sentences in regulations that state what a firm must, must not or may do - by meaning, not only by words. One sentence a row, in English.",
  positionals: [{ name: "words", required: true, variadic: true, help: "what you look for, in plain words (quotes are optional)" }],
  flags: {
    jurisdiction: { kind: "string", value: "code", help: "Only this jurisdiction, e.g. SG" },
    regulator: { kind: "string", value: "code", help: "Only this regulator, e.g. MAS" },
    category: { kind: "string", value: "label", help: "One label. Default: obligation, prohibition and permission", choices: CATEGORIES },
    document: { kind: "string", value: "uid", help: "Only sentences of this document" },
    limit: { kind: "int", help: "Rows to show, 1-20 (default 10)" },
  },
  notes: ["Not every document is covered yet: no hit here does not mean no rule exists. Research aid, not legal advice."],
  examples: ['obligations "deadline to report a cyber incident" --jurisdiction SG', "obligations who must appoint a compliance officer", "obligations outsourcing --document <uid>"],
};

export const SIMILAR: CommandSpec = {
  name: "similar",
  summary: "For one sentence found with `obligations`: the sentences of other jurisdictions that state the same kind of duty, the surest first.",
  positionals: [{ name: "id", required: true, help: "the id of an `obligations` row" }],
  flags: {
    jurisdiction: { kind: "string", value: "code", help: "Look only in this jurisdiction" },
    limit: { kind: "int", help: "Rows to show, 1-10 (default 5)" },
  },
  notes: ["The candidates are found by meaning and checked by a model: read the sentences before you conclude that two rules match."],
  examples: ["similar <id>", "similar <id> --jurisdiction SG"],
};

interface Duty {
  id: string;
  text: string;
  lead_in: string;
  category: string;
  section: string;
  document: { uid: string; title: string; regulator: string; jurisdiction: string; published: string | null };
  same?: number;
}

const row = (h: Duty) => ({
  id: h.id,
  category: h.category,
  regulator: h.document.regulator,
  jurisdiction: h.document.jurisdiction,
  published: h.document.published,
  document: cut(h.document.title, 80),
  section: cut(h.section, 80),
  text: h.lead_in ? `${h.lead_in} ${h.text}` : h.text,
});

const ID_NOTE = 'the document\'s uid is the part of `id` before "_"';
const IN_PLACE = run('doc <document uid> --query "<words of the sentence>"', "to read the sentence in its place");

export async function obligationsCommand(args: string[]): Promise<string> {
  const { flags: f, positionals } = parseArgs(OBLIGATIONS, args);
  const query = positionals.join(" ").trim();
  const d = await apiGet<{ query: string; filter: Record<string, string>; mode: string; note?: string; count: number; hits: Duty[] }>("/v1/obligations", {
    q: query,
    jurisdiction: str(f.jurisdiction),
    regulator: str(f.regulator),
    category: str(f.category),
    document: str(f.document),
    limit: num(f.limit),
  });
  if (!d.hits.length) {
    return compose(
      toon({
        query: d.query,
        filters: pairs(d.filter) || undefined,
        obligations: "0 sentences match. Not every document has its sentences in this index yet: no hit here does not mean no rule exists",
        note: d.note,
      }),
      helpBlock([run(`search ${shellArg(d.query)}`, "to search the documents by words")]),
    );
  }
  return compose(
    toon({
      query: d.query,
      filters: pairs(d.filter) || undefined,
      count: `${d.hits.length} (${d.mode === "meaning" ? "nearest in meaning first" : "keyword matches only"})`,
      note: d.note,
      obligations: d.hits.map(row),
      id: ID_NOTE,
    }),
    helpBlock([run("similar <id>", "for the same kind of duty in other jurisdictions"), IN_PLACE]),
  );
}

export async function similarCommand(args: string[]): Promise<string> {
  const { flags: f, positionals } = parseArgs(SIMILAR, args);
  const d = await apiGet<{ sentence: Duty; same_kind: Duty[]; checked: number }>(`/v1/obligations/${encodeURIComponent(positionals[0])}/similar`, {
    jurisdiction: str(f.jurisdiction),
    limit: num(f.limit),
  });
  const s = row(d.sentence);
  const sentence = { id: s.id, regulator: s.regulator, jurisdiction: s.jurisdiction, document: s.document, text: s.text };
  if (!d.same_kind.length) {
    return compose(
      toon({
        sentence,
        same_kind: `0 of the ${d.checked} nearest sentences in other jurisdictions state the same kind of duty. That is the result of a check, not proof that no such rule exists`,
      }),
      helpBlock([run('obligations "<the duty in plain words>" --jurisdiction <code>', "to look in one jurisdiction")]),
    );
  }
  return compose(
    toon({
      sentence,
      checked: d.checked,
      same_kind: d.same_kind.map((h) => ({ same: h.same, ...row(h) })),
      same: "0.5 to 1: how sure the check is that the two sentences state the same kind of duty",
      id: ID_NOTE,
    }),
    helpBlock([IN_PLACE]),
  );
}
