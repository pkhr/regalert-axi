/** `search` and `recent`: lists of documents — a count with the total, a few columns, and what to run next. */
import { apiGet } from "../api.js";
import { parseArgs, str, num, type CommandSpec, type FlagSpec } from "../args.js";
import { compose, flags, helpBlock, pairs, run, shellArg, toon } from "../output.js";

const FILTER_FLAGS: Record<string, FlagSpec> = {
  regulator: { kind: "string", value: "code", help: "Regulator code, e.g. CBN. Some codes exist in several jurisdictions: add --jurisdiction" },
  jurisdiction: { kind: "string", value: "code", help: "Jurisdiction code, e.g. NG, SG, GB; a US state is US-NY" },
  region: { kind: "string", value: "region", help: "Africa, APAC, CentralAsia, EU, LATAM, MENAP, NA, SEA, SouthAsia or USA" },
  topic: { kind: "string", value: "topic", help: "One topic tag, e.g. capital, aml (see `regalert-axi topics`)" },
};

const FIELDS_FLAG: FlagSpec = {
  kind: "string",
  value: "a,b,c",
  help: "Columns, comma-separated. Default: uid,title,published,regulator,summary (summary = its first 300 characters). More: summary_full, topics, jurisdiction, identifier, url",
};

const RENAMED = {
  "--country": "Use `--jurisdiction <code>` for a country",
  "--from": "Use `--since <YYYY-MM-DD>`",
  "--to": "Use `--until <YYYY-MM-DD>`",
  "--after": "Use `--since <YYYY-MM-DD>`",
  "--before": "Use `--until <YYYY-MM-DD>`",
};

export const SEARCH: CommandSpec = {
  name: "search",
  summary: "Search the documents by words. Each hit: uid, title, date, regulator and the start of its summary; the count is exact.",
  positionals: [{ name: "words", required: true, variadic: true, help: "the words to search for (quotes are optional)" }],
  flags: {
    ...FILTER_FLAGS,
    sort: { kind: "string", value: "order", help: "relevance (default), or newest = the most recent of the 200 most relevant hits", choices: ["relevance", "newest"] },
    limit: { kind: "int", min: 1, max: 50, help: "Rows to show, 1-50 (default 10)" },
    fields: FIELDS_FLAG,
  },
  renamed: { ...RENAMED, "--query": 'The words are the argument: `regalert-axi search "<words>"`', "--q": 'The words are the argument: `regalert-axi search "<words>"`' },
  examples: ['search "capital adequacy" --regulator CBN', "search stablecoin reserve --topic stablecoins --sort newest", 'search "outsourcing" --jurisdiction SG --limit 25'],
};

export const RECENT: CommandSpec = {
  name: "recent",
  summary: "What was published, newest first, with the exact total. No flags = the newest documents of all regulators.",
  flags: {
    ...FILTER_FLAGS,
    since: { kind: "string", value: "YYYY-MM-DD", help: "First date, inclusive" },
    until: { kind: "string", value: "YYYY-MM-DD", help: "Last date, inclusive" },
    limit: { kind: "int", min: 1, max: 100, help: "Rows to show, 1-100 (default 20)" },
    offset: { kind: "int", help: "Rows to skip, to page through the total (default 0)" },
    fields: { ...FIELDS_FLAG, help: `${FIELDS_FLAG.help}, type, language, source` },
  },
  renamed: RENAMED,
  notes: ["Documents with no publication date are not listed here; `search` finds them."],
  examples: ["recent", "recent --regulator CBN --since 2026-09-01", "recent --region EU --topic crypto --limit 50"],
};

interface DocumentList {
  query?: string;
  filter: Record<string, string>;
  sort?: string;
  total: number;
  count: number;
  offset?: number;
  has_more?: boolean;
  fields: string[];
  documents: Array<Record<string, unknown>>;
}

const PAGE = "https://regalert.today/document/<uid>";

/** The hint that widens the summary column, when the rows carry only its first characters. */
function wholeSummaries(command: string, fields: string[]): string {
  if (!fields.includes("summary") || fields.includes("summary_full")) return "";
  const wider = fields.map((f) => (f === "summary" ? "summary_full" : f)).join(",");
  return run(`${command} --fields ${wider}`, "for whole summaries (shown: the first 300 characters)");
}

const READ_HINTS = [run('doc <uid> --query "<words>"', "to read only the matching passages of one document"), run("doc <uid>", "to read it from the start, with summary and lineage")];

export async function searchCommand(args: string[]): Promise<string> {
  const { flags: f, positionals } = parseArgs(SEARCH, args);
  const query = positionals.join(" ").trim();
  const filter = { regulator: str(f.regulator), jurisdiction: str(f.jurisdiction), region: str(f.region), topic: str(f.topic) };
  const d = await apiGet<DocumentList>("/v1/search", { q: query, ...filter, sort: str(f.sort), limit: num(f.limit), fields: str(f.fields) });
  // Suggested commands carry the filters as the server wrote them (CBN, not cbn).
  const base = `search ${shellArg(d.query ?? query)} ${flags({ ...d.filter, sort: d.sort === "newest" ? "newest" : undefined })}`.trim();
  const custom = str(f.fields) ? ` --fields ${d.fields.join(",")}` : "";

  if (!d.documents.length) {
    return compose(
      toon({ query: d.query, filters: pairs(d.filter) || undefined, documents: `0 documents match these words${pairs(d.filter) ? " with these filters" : ""}` }),
      helpBlock([
        run('search "<other words>"', "- the first words count most"),
        pairs(d.filter) ? run(`search ${shellArg(d.query ?? query)}`, "for the same words with no filter") : "",
        run("regulators", "and `regalert-axi topics` for the codes the filters take"),
      ]),
    );
  }
  return compose(
    toon({
      query: d.query,
      filters: pairs(d.filter) || undefined,
      count: `${d.count} of ${d.total} total (${d.sort === "newest" ? "the newest of the most relevant 200" : "most relevant first"})`,
      documents: d.documents,
      page: d.fields.includes("url") ? undefined : PAGE,
    }),
    helpBlock([
      ...READ_HINTS,
      d.total > d.count ? (d.count < 50 ? run(`${base} --limit 50${custom}`, `for more of the ${d.total}`) : "Add --regulator, --jurisdiction, --region or --topic to narrow the search") : "",
      wholeSummaries(base, d.fields),
    ]),
  );
}

export async function recentCommand(args: string[]): Promise<string> {
  const { flags: f } = parseArgs(RECENT, args);
  const d = await apiGet<DocumentList>("/v1/recent", {
    regulator: str(f.regulator),
    jurisdiction: str(f.jurisdiction),
    region: str(f.region),
    topic: str(f.topic),
    since: str(f.since),
    until: str(f.until),
    limit: num(f.limit),
    offset: num(f.offset),
    fields: str(f.fields),
  });
  const offset = d.offset ?? 0;
  const limit = num(f.limit);
  const base = `recent ${flags({ ...d.filter, limit })}`.trim();
  const custom = str(f.fields) ? ` --fields ${d.fields.join(",")}` : "";
  const scope = pairs(d.filter) ? { filters: pairs(d.filter) } : { scope: "all regulators" };

  if (!d.documents.length) {
    return compose(
      toon({ ...scope, documents: d.total ? `0 documents from offset ${offset}: there are ${d.total} in all` : "0 documents were published with these filters" }),
      helpBlock([
        d.total ? run(`${base} --offset 0`, "for the first page") : "",
        !d.total && (d.filter.since || d.filter.until) ? "Widen --since / --until" : "",
        !d.total ? run('search "<words>"', "to search by words, any date (documents with no date are found only there)") : "",
      ]),
    );
  }
  const last = offset + d.count;
  return compose(
    toon({
      ...scope,
      count: `${offset + 1}-${last} of ${d.total} total (newest first)`,
      documents: d.documents,
      page: d.fields.includes("url") ? undefined : PAGE,
    }),
    helpBlock([
      d.has_more ? run(`${base} --offset ${last}${custom}`, `for the next ${Math.min(limit ?? 20, d.total - last)}`) : "",
      ...READ_HINTS.slice(0, 1),
      pairs(d.filter) ? "" : "Narrow with --regulator <code>, --jurisdiction <code>, --region <region>, --topic <topic>, --since <YYYY-MM-DD>",
      wholeSummaries(base, d.fields),
    ]),
  );
}
