# regalert-axi

Search and read financial regulation from the shell, in a form an AI agent can afford to read.

[RegAlert](https://regalert.today) tracks the official publications of about 370 financial regulators in about 190
jurisdictions — central banks, securities and insurance regulators, sanctions authorities — and gives each one an
English summary and the English text, on the day it is published. `regalert-axi` is its command line, built to the
[AXI](https://axi.md) principles: [TOON](https://toonformat.dev) output, a few fields by default, parts of long texts
with the way to the rest, exact totals, errors that name the fix, and the next commands after every answer.

```sh
$ npx -y regalert-axi search "capital adequacy" --regulator CBN --limit 2
query: capital adequacy
filters: regulator=CBN
count: 2 of 415 total (most relevant first)
documents[2]{uid,title,published,regulator,summary}:
  026bf3d9-9c87-484e-a80f-a7362a2de4fc,Liquidity and Capital Adequacy Ratio Computation,2009-01-29,CBN,"The Central Bank of Nigeria (CBN) has issued a circular regarding the computation and reporting of liquidity ratios…"
  29d21e71-d071-4c1a-bf07-d8408ea62cd7,Review of Risk Weights on Certain Exposures in the Computation of Capital Adequacy,2013-02-19,CBN,"The Central Bank of Nigeria has revised risk weights for certain exposures…"
page: "https://regalert.today/document/<uid>"
help[4]:
  Run `regalert-axi doc <uid> --query "<words>"` to read only the matching passages of one document
  Run `regalert-axi doc <uid>` to read it from the start, with summary and lineage
  Run `regalert-axi search "capital adequacy" --regulator CBN --limit 50` for more of the 415
  Run `regalert-axi search "capital adequacy" --regulator CBN --fields uid,title,published,regulator,summary_full` for whole summaries (shown: the first 300 characters)
```

(The two summaries are cut here to fit the page.)

## Start

Tell your agent:

```
Run `npx -y regalert-axi` and follow what it prints.
```

Or by hand:

```sh
npx -y regalert-axi auth login     # prints an address; open it, sign in, approve
npx -y regalert-axi                # the newest documents, and the commands that follow
```

Access is free with a RegAlert account, under fair use: at bulk scale full-text reads pause until the next day;
search, lists and lineage keep working. Node 20 or newer.

## Commands

| Command | What it does |
|---|---|
| `regalert-axi` | The newest documents and what to run next |
| `search "<words>"` | Search by words. `--regulator`, `--jurisdiction`, `--region`, `--topic`, `--sort`, `--limit`, `--fields` |
| `recent` | What was published, newest first. The same filters, `--since`, `--until`, `--offset` |
| `doc <uid>` | Read one document. `--query "<words>"` prints only the matching passages; `--offset`, `--full`, `--original` |
| `lineage <uid>` | What a document amends or replaces, and what amended or replaced it |
| `regulators` | The regulators and their codes. `--region`, `--jurisdiction`, `--query` |
| `topics` | The topic tags |
| `obligations "<words>"`, `similar <id>` | Rule sentences found by meaning, and the same duty in other jurisdictions (listed when the server offers them) |
| `account` | This account's access |
| `auth login`, `auth status`, `auth logout` | Sign in, see the sign-in, forget it |
| `setup hooks` | Show the home view at the start of every agent session |
| `update` | Upgrade to the latest version |

`regalert-axi <command> --help` prints one command's flags and examples.

### Reading a long document

A regulation can be 300,000 characters. `doc <uid>` prints the first 20,000 and says how to get the next part.
`doc <uid> --query "incident reporting deadline"` prints only the passages that hold those words, each with its
offset and the headings above it; `doc <uid> --offset <offset>` reads on from one of them.

### Codes

Filters take codes, not names. A wrong code is an error that names the right one:

```sh
$ regalert-axi search capital --regulator "Central Bank of Nigeria"
error: "Unknown regulator code \"Central Bank of Nigeria\". The filter takes the regulator's code (e.g. CBN), not its name."
code: UNKNOWN_REGULATOR
suggestions[1]{code,name,jurisdiction}:
  CBN,Central Bank of Nigeria,NG
help[1]:
  Use `--regulator CBN` for Central Bank of Nigeria (NG)
```

Some regulator codes are used in several jurisdictions (`FSC` in eight). Such a code alone is refused, with the
list; add `--jurisdiction`.

## Sign-in

`auth login` signs in with OAuth 2.1 (authorization code with PKCE) in a browser. It prints the address and returns
at once — an agent's shell shows a command's output only when the command ends, so a command that waited for the
browser would show the address too late. A small listener on `127.0.0.1` takes the browser's return in the
background, stores the tokens and stops; it also stops after ten minutes.

- Browser on another machine: the browser ends on an address that starts with `http://127.0.0.1` and cannot load.
  Copy it and run `regalert-axi auth login --callback-url "<address>"`.
- `auth login --wait` waits in the foreground instead.
- `REGALERT_TOKEN`, when set, is sent as the bearer token and no sign-in is needed.

The sign-in is kept in `~/.config/regalert-axi/credentials.json` (mode 0600; `REGALERT_AXI_HOME` or
`XDG_CONFIG_HOME` move it).

## For agents: the hook or the skill

Two ways to make an agent know the tool is there. You need one.

**The session hook** puts the home view (about 350 tokens) at the start of every Claude Code, Codex and OpenCode
session:

```sh
npm install -g regalert-axi
regalert-axi setup hooks              # --project for this repository only
regalert-axi setup hooks --status
regalert-axi setup hooks --uninstall  # removes only the entry this tool wrote
```

**The skill** costs nothing until a task needs it:

```sh
npx skills add pkhr/regalert-axi --skill regalert-axi
```

No other command touches an agent's settings.

## Output and exit codes

- stdout: the answer, as TOON — or the error, in the same form (`error`, `code`, `help`). Nothing else is written
  to stdout. A document's text is printed as it is, between `--- text ---` markers, so `grep`, `head` and `tail` work.
- Exit 0: success, also "nothing found" and no-ops. Exit 1: an error. Exit 2: a usage error — an unknown flag, a
  missing argument, a code the server does not know. Unknown flags are refused by name, never ignored.
- No command asks a question.

## Other ways in

The same data is an MCP server (`https://mcp.regalert.today/mcp`) and a REST API. The reference for agents is
<https://mcp.regalert.today/llms.txt>.

## Development

```sh
npm install
npm test             # builds, then runs the tests (a stand-in server; no network)
npm run typecheck
npm run build:skill  # after a change to src/skill.ts
REGALERT_API_URL=http://127.0.0.1:3100 REGALERT_TOKEN=dev-token npm run dev -- search capital
```

The documents are public regulatory instruments; the summaries and translations are RegAlert's. Research aid, not
legal advice. MIT licence.
