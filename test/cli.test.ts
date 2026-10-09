/** Every command, run in-process against a stand-in server: what it asks the server, what it prints, how it exits. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { editDistance, topLevelHelp } from "../src/cli.js";
import { storeRoutes } from "../src/config.js";
import { cli, startStub, tempHome, UID, type Stub } from "./helpers.js";

let stub: Stub;
let home: { dir: string; cleanup: () => void };

beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());
beforeEach(() => {
  home = tempHome();
  process.env.REGALERT_AXI_HOME = home.dir;
  process.env.REGALERT_API_URL = stub.url;
  process.env.REGALERT_TOKEN = "test-token";
  stub.calls.length = 0;
});
afterEach(() => {
  home.cleanup();
  delete process.env.REGALERT_TOKEN;
});

const doc = (n: number) => ({ uid: `0000000${n}-0000-4000-8000-000000000000`, title: `Circular ${n}, on capital`, published: `2026-0${n}-01`, regulator: "CBN", summary: "Banks must hold more capital." });
const FIELDS = ["uid", "title", "published", "regulator", "summary"];

describe("search", () => {
  it("sends the words and the filters, prints the count with the total, and carries the filters into the next commands", async () => {
    stub.route((c) =>
      c.path === "/v1/search"
        ? { json: { query: "capital adequacy", filter: { regulator: "CBN" }, sort: "relevance", total: 415, count: 2, fields: FIELDS, documents: [doc(1), doc(2)] } }
        : undefined,
    );
    const { out, code } = await cli("search", "capital", "adequacy", "--regulator", "cbn", "--limit", "2");
    expect(code).toBe(0);
    expect(stub.calls[0].query).toEqual({ q: "capital adequacy", regulator: "cbn", limit: "2" });
    expect(stub.calls[0].auth).toBe("Bearer test-token");
    expect(out).toBe(
      [
        "query: capital adequacy",
        "filters: regulator=CBN",
        "count: 2 of 415 total (most relevant first)",
        "documents[2]{uid,title,published,regulator,summary}:",
        '  00000001-0000-4000-8000-000000000000,"Circular 1, on capital",2026-01-01,CBN,Banks must hold more capital.',
        '  00000002-0000-4000-8000-000000000000,"Circular 2, on capital",2026-02-01,CBN,Banks must hold more capital.',
        'page: "https://regalert.today/document/<uid>"',
        "help[4]:",
        '  Run `regalert-axi doc <uid> --query "<words>"` to read only the matching passages of one document',
        "  Run `regalert-axi doc <uid>` to read it from the start, with summary and lineage",
        '  Run `regalert-axi search "capital adequacy" --regulator CBN --limit 50` for more of the 415',
        '  Run `regalert-axi search "capital adequacy" --regulator CBN --fields uid,title,published,regulator,summary_full` for whole summaries (shown: the first 300 characters)',
        "",
      ].join("\n"),
    );
  });

  it("no hit is an answer: a sentence, exit 0, and ways on", async () => {
    stub.route(() => ({ json: { query: "zzzz", filter: { jurisdiction: "NG" }, sort: "relevance", total: 0, count: 0, fields: FIELDS, documents: [] } }));
    const { out, code } = await cli("search", "zzzz", "--jurisdiction", "NG");
    expect(code).toBe(0);
    expect(out).toMatch(/^query: zzzz\nfilters: jurisdiction=NG\ndocuments: 0 documents match these words with these filters\nhelp\[3\]:/);
    expect(out).toContain("Run `regalert-axi search zzzz` for the same words with no filter");
  });

  it("a wrong code from the server is a usage error with the flags to type", async () => {
    stub.route(() => ({
      status: 400,
      json: {
        error: "ambiguous_regulator",
        message: "The code FSC is used by 2 regulators in different jurisdictions. Add `jurisdiction` to say which one.",
        suggestions: [
          { code: "FSC", name: "Financial Services Commission Mauritius", jurisdiction: "MU" },
          { code: "FSC", name: "Financial Services Commission Korea", jurisdiction: "KR" },
        ],
      },
    }));
    const { out, code } = await cli("search", "capital", "--regulator", "FSC");
    expect(code).toBe(2);
    expect(out).toBe(
      [
        "error: The code FSC is used by 2 regulators in different jurisdictions. Add --jurisdiction to say which one.",
        "code: AMBIGUOUS_REGULATOR",
        "suggestions[2]{code,name,jurisdiction}:",
        "  FSC,Financial Services Commission Mauritius,MU",
        "  FSC,Financial Services Commission Korea,KR",
        "help[2]:",
        "  Use `--regulator FSC --jurisdiction MU` for Financial Services Commission Mauritius",
        "  Use `--regulator FSC --jurisdiction KR` for Financial Services Commission Korea",
        "",
      ].join("\n"),
    );
  });

  it("an unknown flag never reaches the server", async () => {
    const { out, code } = await cli("search", "capital", "--regulater", "CBN");
    expect(code).toBe(2);
    expect(out).toMatch(/^error: unknown flag --regulater for `search`\ncode: UNKNOWN_FLAG\nhelp\[2\]:\n  valid flags for `search`: --regulator, /);
    expect(stub.calls.length).toBe(0);
  });
});

describe("recent", () => {
  it("pages: the next command holds the filters, the page size and the columns the caller chose", async () => {
    stub.route(() => ({
      json: { filter: { regulator: "CBN", since: "2026-06-01" }, total: 15, offset: 10, count: 2, has_more: true, fields: ["uid", "title"], documents: [{ uid: "u1", title: "A" }, { uid: "u2", title: "B" }] },
    }));
    const { out } = await cli("recent", "--regulator", "CBN", "--since", "2026-06-01", "--limit", "2", "--offset", "10", "--fields", "uid,title");
    expect(stub.calls[0].query).toEqual({ regulator: "CBN", since: "2026-06-01", limit: "2", offset: "10", fields: "uid,title" });
    expect(out).toContain("count: 11-12 of 15 total (newest first)");
    expect(out).toContain("Run `regalert-axi recent --regulator CBN --since 2026-06-01 --limit 2 --offset 12 --fields uid,title` for the next 2");
    // no summary column, so no hint about whole summaries
    expect(out).not.toContain("summary_full");
  });

  it("no filter says so; nothing published says so", async () => {
    stub.route(() => ({ json: { filter: {}, total: 68894, offset: 0, count: 1, has_more: true, fields: FIELDS, documents: [doc(1)] } }));
    expect((await cli("recent")).out).toMatch(/^scope: all regulators\ncount: 1-1 of 68894 total \(newest first\)/);
    stub.route(() => ({ json: { filter: { regulator: "CBN", since: "2026-10-09" }, total: 0, offset: 0, count: 0, has_more: false, fields: FIELDS, documents: [] } }));
    const none = await cli("recent", "--regulator", "CBN", "--since", "2026-10-09");
    expect(none.code).toBe(0);
    expect(none.out).toContain("documents: 0 documents were published with these filters");
  });
});

describe("regulators and topics", () => {
  it("no flags: the totals by region; a filter: the rows and the shared codes", async () => {
    stub.route((c) =>
      c.query.query
        ? { json: { view: "regulators", filter: { query: "nigeria" }, total: 2, fields: ["code", "name", "jurisdiction", "documents"], regulators: [{ code: "CBN", name: "Central Bank of Nigeria", jurisdiction: "NG", documents: 1562 }, { code: "SEC", name: "Securities and Exchange Commission Nigeria", jurisdiction: "NG", documents: 337 }], shared_codes: ["SEC"] } }
        : { json: { view: "regions", regulators: 371, jurisdictions: 192, documents: 70489, regions: [{ region: "Africa", jurisdictions: 36, regulators: 63, documents: 9776 }] } },
    );
    expect((await cli("regulators")).out).toMatch(/^regulators: 371\njurisdictions: 192\ndocuments: 70489\nregions\[1\]\{region,jurisdictions,regulators,documents\}:\n  Africa,36,63,9776\nhelp\[3\]:/);
    const rows = await cli("regulators", "--query", "nigeria");
    expect(rows.out).toContain("count: 2 of 2 total\nregulators[2]{code,name,jurisdiction,documents}:\n  CBN,Central Bank of Nigeria,NG,1562");
    expect(rows.out).toContain("add --jurisdiction with them: SEC");
  });

  it("topics: the tags with their counts; an argument is refused", async () => {
    stub.route(() => ({ json: { total: 2, topics: [{ topic: "capital", documents: 9179 }, { topic: "aml", documents: 4729 }] } }));
    expect((await cli("topics")).out).toMatch(/^count: 2 of 2 total\ntopics\[2\]\{topic,documents\}:\n  capital,9179\n  aml,4729\nhelp\[2\]:/);
    const extra = await cli("topics", "aml");
    expect(extra.code).toBe(2);
    expect(extra.out).toContain("code: UNEXPECTED_ARGUMENT");
  });
});

const read = (over: object = {}) => ({
  document: {
    uid: UID, title: "Circular 3978", identifier: "Circular 3978", instrument_no: null, type: "rule", published: "2020-01-23", language: "pt",
    regulator: "BCB", regulator_name: "Banco Central do Brasil", jurisdiction: "BR", topics: ["aml", "kyc"], summary: "Institutions must implement AML policies.",
    source: "https://bcb.example/3978", url: `https://regalert.today/document/${UID}`, file_url: null,
    mode: "text", text: "Art. 1 …", text_truncated: true, text_offset: 0, text_total_chars: 53516, text_next_offset: 20000,
    original_text_included: false, original_text: null, original_text_truncated: false, original_text_offset: 0, original_text_total_chars: 54025,
    lineage: { status_label: "Amended", cited_by_count: 14, amended_by: [{ uid: "a1", title: "Resolution 591", date: "2026-09-30" }], amended_by_count: 1, cites_not_held: [], cites_not_held_count: 0 },
    ...over,
  },
  charged_usd: "$0.00",
  charged_as: "free",
});

describe("doc", () => {
  it("prints a part by default and says how to get the rest: the next part, the whole text, the passages", async () => {
    stub.route(() => ({ json: read() }));
    const { out, code } = await cli("doc", UID);
    expect(code).toBe(0);
    expect(stub.calls[0].path).toBe(`/v1/documents/${UID}`);
    expect(stub.calls[0].query).toEqual({ max_chars: "20000" });
    expect(out).toMatch(/^document:\n  uid: 8b2890f6-3cf4-435d-bb76-63eae73e4ab3\n  title: Circular 3978\n  identifier: Circular 3978\n  type: rule\n  published: 2020-01-23\n  regulator: BCB — Banco Central do Brasil \(BR\)\n  original_language: pt\n  topics: aml kyc\n/);
    expect(out).toContain("lineage:\n  status: Amended\n  cited_by: 14\n  amended_by[1]{uid,date,title}:\n    a1,2026-09-30,Resolution 591\n");
    expect(out).toContain('text: characters 0-8 of 53516 (truncated)\noriginal: "54025 characters in \\"pt\\", not shown"\n--- text ---\nArt. 1 …\n--- end of part: 8 of 53516 characters ---\nhelp[5]:\n');
    expect(out).toContain(`Run \`regalert-axi doc ${UID} --offset 20000\` for the next part`);
    expect(out).toContain(`Run \`regalert-axi doc ${UID} --full\` for the whole text (53516 characters)`);
    expect(out).toContain(`Run \`regalert-axi doc ${UID} --original\` to add the source-language text`);
    // free access: no line about a charge
    expect(out).not.toContain("charged");
  });

  it("--full, --offset, --original and --max-chars reach the server as its own parameters", async () => {
    stub.route(() => ({ json: read({ text_truncated: false, text_next_offset: null }) }));
    await cli("doc", UID, "--full", "--offset", "20000", "--original");
    expect(stub.calls[0].query).toEqual({ offset: "20000", max_chars: "400000", include_original: "true" });
    await cli("doc", UID, "--max-chars", "1500");
    expect(stub.calls[1].query).toEqual({ max_chars: "1500" });
  });

  it("--query: a short head, the passages with their offsets, and no default part size sent", async () => {
    stub.route(() => ({
      json: read({
        mode: "passages", text: "", text_truncated: false, text_next_offset: null,
        passages: { query: "politically exposed", terms: ["politically", "exposed"], matched: 18, shown: 1, passages: [{ offset: 12794, heading: "Chapter V", text: "Art. 19 The qualification procedures…" }] },
      }),
    }));
    const { out } = await cli("doc", UID, "--query", "politically exposed");
    expect(stub.calls[0].query).toEqual({ query: "politically exposed" });
    expect(out).toContain('passages:\n  words: politically exposed\n  count: "1 of 18 total (the best ones, in document order)"\n  of_characters: 53516\n--- passages ---\n[offset 12794 · Chapter V]\nArt. 19 The qualification procedures…\n--- end of passages ---\nhelp[3]:');
    expect(out).toContain(`Run \`regalert-axi doc ${UID} --query "politically exposed" --max-chars 20000\` for more of the 18 passages`);
    expect(out).not.toContain("summary:");
  });

  it("refuses a uid that is not one, and flags that contradict each other, before any call", async () => {
    const bad = await cli("doc", "nope");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("code: BAD_UID");
    for (const args of [["--full", "--max-chars", "5000"], ["--query", "x", "--offset", "5"], ["--query", "x", "--original"]]) {
      const r = await cli("doc", UID, ...args);
      expect(r.code).toBe(2);
      expect(r.out).toContain("code: CONFLICTING_FLAGS");
    }
    expect(stub.calls.length).toBe(0);
  });

  it("an unknown document and a paused account are errors (exit 1) with a way on", async () => {
    stub.route(() => ({ status: 404, json: { error: "not_found", message: `No published document with uid ${UID}.` } }));
    const gone = await cli("doc", UID);
    expect(gone.code).toBe(1);
    expect(gone.out).toBe(`error: No published document with uid ${UID}.\ncode: NOT_FOUND\nhelp[1]:\n  Run \`regalert-axi search "<words>"\` to find a document and its uid\n`);
    stub.route(() => ({ status: 429, json: { error: "fair_use", message: "This account has reached today's fair-use limit for full-text reads." } }));
    const paused = await cli("doc", UID);
    expect(paused.code).toBe(1);
    expect(paused.out).toContain("code: FAIR_USE");
    expect(paused.out).toContain("search, recent, regulators, topics and lineage keep working");
  });
});

describe("lineage", () => {
  const page = (edges: object[], total: number, has_more = false) => ({ uid: UID, edges, total, offset: 0, has_more });
  it("with no --direction it asks for both and prints both, each with its total", async () => {
    stub.route((c) =>
      c.query.direction === "incoming"
        ? { json: page([{ relation: "amends", uid: "a1", title: "Resolution 591", regulator: "BCB", date: "2026-09-30", cite: null }], 14, true) }
        : { json: page([{ relation: "issued_under", uid: null, title: null, regulator: null, date: null, cite: "Law No. 9.613 dated 1998-03-03" }], 1) },
    );
    const { out } = await cli("lineage", UID, "--limit", "1");
    expect(stub.calls.map((c) => c.query.direction).sort()).toEqual(["incoming", "outgoing"]);
    expect(out).toContain("incoming: 1-1 of 14 total (newer instruments that cite this document)\nincoming_documents[1]{relation,uid,date,regulator,title}:\n  amends,a1,2026-09-30,BCB,Resolution 591\n");
    expect(out).toContain("outgoing: 1-1 of 1 total (older instruments this document cites)\noutgoing_not_in_corpus[1]{relation,cite}:\n  issued_under,Law No. 9.613 dated 1998-03-03\n");
    expect(out).toContain(`Run \`regalert-axi lineage ${UID} --direction incoming --limit 1 --offset 1\` for the next 1 incoming links`);
  });

  it("no links is a sentence; --offset without --direction is refused", async () => {
    stub.route(() => ({ json: page([], 0) }));
    const none = await cli("lineage", UID, "--direction", "incoming");
    expect(none.code).toBe(0);
    expect(none.out).toContain("incoming: 0 confirmed links (newer instruments that cite this document)");
    const bad = await cli("lineage", UID, "--offset", "20");
    expect(bad.code).toBe(2);
  });
});

describe("obligations", () => {
  it("is not offered by every server: a clear error, and the command is in the help only when the server has it", async () => {
    stub.route(() => ({ status: 404, json: { error: "not_enabled", message: "Search over rule sentences is not enabled on this server." } }));
    const r = await cli("obligations", "report", "incident");
    expect(r.code).toBe(1);
    expect(r.out).toContain("error: This server does not offer the search over rule sentences yet\ncode: NOT_ENABLED");
    expect(topLevelHelp(false)).not.toContain("obligations");
    expect(topLevelHelp(true)).toContain('obligations "<words>"');
    storeRoutes(["GET /v1/search?q=…", "GET /v1/obligations?q=…"]);
    expect(topLevelHelp()).toContain("similar <id>");
  });

  it("prints one sentence a row, with its list lead-in in front", async () => {
    stub.route(() => ({
      json: {
        query: "board approval", filter: { jurisdiction: "SG" }, mode: "meaning", count: 1,
        hits: [{ id: `${UID}_12`, text: "obtain the approval of the board;", lead_in: "A bank must:", category: "obligation", section: "Part 3", document: { uid: UID, title: "Notice 12", regulator: "MAS", jurisdiction: "SG", published: "2026-03-01" } }],
      },
    }));
    const { out } = await cli("obligations", "board", "approval", "--jurisdiction", "SG");
    expect(stub.calls[0].query).toEqual({ q: "board approval", jurisdiction: "SG" });
    expect(out).toContain(`obligations[1]{id,category,regulator,jurisdiction,published,document,section,text}:\n  ${UID}_12,obligation,MAS,SG,2026-03-01,Notice 12,Part 3,"A bank must: obtain the approval of the board;"`);
    expect(out).toContain("Run `regalert-axi similar <id>`");
  });
});

describe("when the server is not itself", () => {
  it("a 500, a bot challenge and no server at all are one clear error each, never a stack trace", async () => {
    stub.route(() => ({ status: 500, json: { error: "unavailable", message: "x" } }));
    const five = await cli("topics");
    expect(five.code).toBe(1);
    expect(five.out).toBe("error: RegAlert could not answer this call just now\ncode: UNAVAILABLE\nhelp[1]:\n  Run the same command again in a minute\n");

    stub.route(() => ({ status: 429, text: "<html>Security Checkpoint</html>" }));
    const wall = await cli("topics");
    expect(wall.out).toContain('error: "RegAlert could not be reached (HTTP 429, not a RegAlert answer)"');

    process.env.REGALERT_API_URL = "http://127.0.0.1:9";
    const down = await cli("topics");
    expect(down.code).toBe(1);
    expect(down.out).toContain("code: UNAVAILABLE");
    expect(down.out).not.toMatch(/\bat \S+ \(/);
  });

  it("a token the server refuses says so and names the way to sign in again", async () => {
    stub.route(() => ({ status: 401, json: { error: "unauthorized", message: "…" } }));
    const r = await cli("topics");
    expect(r.code).toBe(1);
    expect(r.out).toBe("error: RegAlert does not accept the token in REGALERT_TOKEN\ncode: NOT_SIGNED_IN\nhelp[1]:\n  Run `regalert-axi auth login` to sign in again\n");
  });
});

describe("the frame", () => {
  it("--help lists every command in one line each, and a command's --help is its own reference", async () => {
    const top = await cli("--help");
    expect(top.code).toBe(0);
    expect(top.out).toMatch(/^usage: regalert-axi \[command\] \[args\] \[flags\]\ndescription: /);
    for (const name of ["search", "recent", "doc <uid>", "lineage <uid>", "regulators", "topics", "account", "auth login|status|logout", "setup hooks"]) expect(top.out).toContain(`  ${name}`);
    const one = await cli("doc", "--help");
    expect(one.out).toMatch(/^usage: regalert-axi doc <uid> \[flags\]\n/);
    expect(one.out).toContain("--query <words>");
    expect((await cli("auth", "login", "--help")).out).toMatch(/^usage: regalert-axi auth login \[flags\]\n/);
    expect((await cli("auth", "--help")).out).toMatch(/^usage: regalert-axi auth <login\|status\|logout> \[flags\]\n/);
    expect((await cli("setup", "--help")).out).toMatch(/^usage: regalert-axi setup hooks \[flags\]\n/);
    expect(stub.calls.length).toBe(0);
  });

  it("an unknown command names the nearest one; a flag before the command shows the command the right way round", async () => {
    const typo = await cli("serch", "capital");
    expect(typo.code).toBe(2);
    expect(typo.out).toBe(
      'error: unknown command `serch`\ncode: UNKNOWN_COMMAND\nhelp[3]:\n  Run `regalert-axi search "<words>"`\n  commands: search, recent, doc, lineage, regulators, topics, account, auth, setup\n  Run `regalert-axi --help` for what each one does\n',
    );
    const order = await cli("--limit", "5", "search", "capital");
    expect(order.code).toBe(2);
    expect(order.out).toBe(
      "error: flags come after the command; got `--limit` first\ncode: FLAG_BEFORE_COMMAND\nhelp[2]:\n  Run `regalert-axi search --limit 5 capital`\n  Run `regalert-axi --help` for the commands\n",
    );
    expect(editDistance("serch", "search")).toBe(1);
    expect(editDistance("docs", "doc")).toBe(1);
    expect(editDistance("frobnicate", "search")).toBeGreaterThan(2);
  });

  it("--version is the bare version", async () => {
    const { out, code } = await cli("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("the home view", () => {
  it("shows live content and the commands that follow, and asks the server for a small page", async () => {
    stub.route((c) => {
      if (c.path === "/v1/recent") return { json: { total: 68894, documents: [{ uid: "u1", title: "Change in Daily Minimum Cash Reserve Maintenance Requirement", published: "2026-10-09", regulator: "RBI" }] } };
      if (c.path === "/v1/regulators") return { json: { view: "regions", regulators: 371, jurisdictions: 192, documents: 70489, regions: [] } };
      if (c.path === "/v1") return { json: { routes: ["GET /v1/search?q=…"] } };
      return undefined;
    });
    const { out, code } = await cli();
    expect(code).toBe(0);
    expect(stub.calls.find((c) => c.path === "/v1/recent")?.query).toEqual({ limit: "5", fields: "uid,title,published,regulator" });
    expect(out).toMatch(/^bin: .+\ndescription: Search and read the official publications of about 370 financial regulators worldwide \(RegAlert\) with English summaries and text\ncorpus: "70489 documents, 371 regulators, 192 jurisdictions"\nnewest\[1\]\{uid,title,published,regulator\}:\n  u1,Change in Daily Minimum Cash Reserve Maintenance Requirement,2026-10-09,RBI\nhelp\[4\]:\n/);
    expect(out).not.toContain("obligations");
    expect(out.length).toBeLessThan(1_300);
  });

  it("with no sign-in it says what the tool is and how to sign in, and exits 0", async () => {
    delete process.env.REGALERT_TOKEN;
    const { out, code } = await cli();
    expect(code).toBe(0);
    expect(out).toMatch(/^bin: .+\ndescription: .+\naccount: not signed in\nhelp\[2\]:\n  Run `regalert-axi auth login` to sign in \(free with a RegAlert account\)\n  Run `regalert-axi --help` for the commands\n$/);
    expect(stub.calls.length).toBe(0);
  });

  it("with the server down it still exits 0: it opens every hooked session", async () => {
    process.env.REGALERT_API_URL = "http://127.0.0.1:9";
    const { out, code } = await cli();
    expect(code).toBe(0);
    expect(out).toContain("live: ");
    expect(out).toContain("not available");
  });
});
