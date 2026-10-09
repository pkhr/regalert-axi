/** `regulators` and `topics`: the codes the filters take. */
import { apiGet } from "../api.js";
import { parseArgs, str, type CommandSpec } from "../args.js";
import { compose, flags, helpBlock, pairs, run, toon } from "../output.js";

export const REGULATORS: CommandSpec = {
  name: "regulators",
  summary: "The regulators covered and their codes. No flags = totals by region.",
  flags: {
    region: { kind: "string", value: "region", help: "The regulators of one region" },
    jurisdiction: { kind: "string", value: "code", help: "The regulators of one jurisdiction, e.g. NG" },
    query: { kind: "string", value: "text", help: 'Part of a regulator\'s name, its code, or a country: "nigeria", "securities"' },
    all: { kind: "boolean", help: "Every regulator, with no filter (a long list)" },
    fields: { kind: "string", value: "a,b,c", help: "Columns. Default: code,name,jurisdiction,documents. More: jurisdiction_name, region, website" },
  },
  renamed: { "--country": "Use `--jurisdiction <code>`, or `--query \"<country name>\"`", "--name": 'Use `--query "<part of the name>"`' },
  examples: ["regulators", 'regulators --query "nigeria"', "regulators --region MENAP", "regulators --jurisdiction SG --fields code,name,website"],
};

export const TOPICS: CommandSpec = {
  name: "topics",
  summary: "The topic tags the --topic filter takes, with the number of documents of each.",
  flags: {},
  examples: ["topics"],
};

type RegulatorData =
  | { view: "regions"; regulators: number; jurisdictions: number; documents: number; regions: Array<Record<string, unknown>> }
  | { view: "regulators"; filter: Record<string, string>; total: number; fields: string[]; regulators: Array<Record<string, unknown>>; shared_codes: string[] };

export async function regulatorsCommand(args: string[]): Promise<string> {
  const { flags: f } = parseArgs(REGULATORS, args);
  const d = await apiGet<RegulatorData>("/v1/regulators", {
    region: str(f.region),
    jurisdiction: str(f.jurisdiction),
    query: str(f.query),
    all: f.all === true,
    fields: str(f.fields),
  });
  if (d.view === "regions") {
    return compose(
      toon({ regulators: d.regulators, jurisdictions: d.jurisdictions, documents: d.documents, regions: d.regions }),
      helpBlock([
        run("regulators --region <region>", "for the regulators of one region, with their codes"),
        run('regulators --query "<part of a name, or a country>"', "to find one regulator's code"),
        run("regulators --all", `for all ${d.regulators}`),
      ]),
    );
  }
  if (!d.regulators.length) {
    return compose(
      toon({ filters: pairs(d.filter) || undefined, regulators: "0 regulators match" }),
      helpBlock([run("regulators", "for the regions and how many regulators each has"), run('regulators --query "<another part of the name>"')]),
    );
  }
  return compose(
    toon({
      filters: pairs(d.filter) || undefined,
      count: `${d.regulators.length} of ${d.total} total`,
      regulators: d.regulators,
      note: d.shared_codes.length ? `Used in more than one jurisdiction, so add --jurisdiction with them: ${d.shared_codes.join(", ")}` : undefined,
    }),
    helpBlock([
      run(`recent --regulator <code>${d.filter.jurisdiction ? ` ${flags({ jurisdiction: d.filter.jurisdiction })}` : ""}`, "for what one regulator published, newest first"),
      run('search "<words>" --regulator <code>', "to search inside one regulator"),
    ]),
  );
}

export async function topicsCommand(args: string[]): Promise<string> {
  parseArgs(TOPICS, args);
  const d = await apiGet<{ total: number; topics: Array<Record<string, unknown>> }>("/v1/topics");
  return compose(
    toon({ count: `${d.topics.length} of ${d.total} total`, topics: d.topics }),
    helpBlock([run('search "<words>" --topic <topic>'), run("recent --topic <topic> --since <YYYY-MM-DD>", "for the newest documents of one topic")]),
  );
}
