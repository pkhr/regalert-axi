/**
 * `auth` and `account`: who this tool is signed in as.
 *
 * `auth login` never waits for the person unless asked to (`--wait`): an
 * agent's shell shows the output of a command only when the command ends, so
 * a command that waits for a browser shows the address too late.
 */
import { apiGet } from "../api.js";
import { helpFor, parseArgs, str, num, type CommandSpec } from "../args.js";
import { authState, beginLogin, finishFromCallbackUrl, listenForCallback, logout, LOGIN_TTL_MS, portOf, spawnListener } from "../auth.js";
import { apiOrigin, loadCredentials } from "../config.js";
import { CliError, UsageError } from "../errors.js";
import { compose, helpBlock, run, toon } from "../output.js";

export const LOGIN: CommandSpec = {
  name: "auth login",
  summary: "Sign in to RegAlert in a browser. Prints the address to open and returns at once; the sign-in completes in the background when it is approved.",
  flags: {
    wait: { kind: "boolean", help: "Wait here until the sign-in is approved (up to 10 minutes)" },
    "callback-url": { kind: "string", value: "address", help: "Finish a sign-in by hand: the whole address the browser ended on (for a browser on another machine)" },
    port: { kind: "int", help: "Loopback port for the browser to return to (default 53682, or a free one)" },
    force: { kind: "boolean", help: "Start a new sign-in although one is stored" },
  },
  notes: ["Free with a RegAlert account. REGALERT_TOKEN, when set, is used as the token and no sign-in is needed."],
  examples: ["auth login", "auth login --wait", 'auth login --callback-url "http://127.0.0.1:53682/callback?code=…&state=…"'],
};

export const STATUS: CommandSpec = {
  name: "auth status",
  summary: "Whether this tool is signed in, and a sign-in that waits for the browser.",
  flags: {},
  examples: ["auth status"],
};

export const LOGOUT: CommandSpec = {
  name: "auth logout",
  summary: "Forget the stored sign-in.",
  flags: {},
  examples: ["auth logout"],
};

/** Run by `auth login` as a background process; not for people. */
const LISTEN: CommandSpec = {
  name: "auth listen",
  summary: "Internal: waits for the browser to return from a sign-in.",
  flags: { port: { kind: "int", help: "Loopback port" } },
  examples: ["auth listen --port 53682"],
};

export const ACCOUNT: CommandSpec = {
  name: "account",
  summary: "This account's access: whether full-text reads are available right now.",
  flags: {},
  examples: ["account"],
};

export const AUTH_HELP = `usage: regalert-axi auth <login|status|logout> [flags]
Sign in to RegAlert (free with an account), see the sign-in, or forget it.
commands[3]:
  login: print the address to open in a browser; --wait to wait for the approval; --callback-url "<address>" to finish by hand
  status: whether this tool is signed in
  logout: forget the stored sign-in
examples[3]:
  regalert-axi auth login
  regalert-axi auth status
  regalert-axi auth logout
`;

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} minutes`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SIGNED_IN_HELP = [run("", "for the newest documents"), run('search "<words>"', "to search the documents")];

async function login(args: string[]): Promise<string> {
  const { flags: f } = parseArgs(LOGIN, args);
  const callback = str(f["callback-url"]);
  if (callback) {
    if (f.wait || f.port !== undefined) throw new UsageError("--callback-url finishes a sign-in; it takes no other flag", "CONFLICTING_FLAGS");
    await finishFromCallbackUrl(callback);
    return compose(toon({ login: "signed in" }), helpBlock(SIGNED_IN_HELP));
  }

  const state = authState();
  if (state.state === "token_from_env") {
    return compose(toon({ login: "not needed: REGALERT_TOKEN is set and is used as the token (no-op)" }), helpBlock([run("account", "to check that the server accepts it")]));
  }
  if (state.state === "signed_in" && !f.force) {
    return compose(toon({ login: "already signed in (no-op)" }), helpBlock([run("account", "for this account's access"), run("auth login --force", "to sign in as another account")]));
  }

  const { client, pending } = await beginLogin(num(f.port));
  const listening = await spawnListener(portOf(client.redirect_uri));
  const byHand = run('auth login --callback-url "<address the browser ends on>"', "when the browser is on another machine: it ends on an address that starts with http://127.0.0.1");

  if (f.wait) {
    if (!listening) throw new CliError("Could not start the listener for the browser to return to", "LISTENER_FAILED", [`Open ${pending.url}`, byHand]);
    // The address must be seen before the wait: stderr is not part of the result, so it is free for it.
    process.stderr.write(`Open this address in a browser and approve:\n${pending.url}\n`);
    const until = Date.now() + LOGIN_TTL_MS;
    while (Date.now() < until) {
      if (loadCredentials().tokens?.access_token) return compose(toon({ login: "signed in" }), helpBlock(SIGNED_IN_HELP));
      await sleep(1_000);
    }
    throw new CliError("The sign-in was not approved within 10 minutes", "LOGIN_EXPIRED", [run("auth login", "to start again")]);
  }

  return compose(
    toon({
      login: listening ? "waiting for the approval in a browser" : "started; the listener did not start, so finish it by hand (see help)",
      url: pending.url,
      expires_in: minutes(pending.expires_at - Date.now()),
    }),
    helpBlock([
      "Open the url in a browser on this machine, sign in to RegAlert and approve; the sign-in then completes by itself",
      run("auth status", "to see when it is done"),
      byHand,
    ]),
  );
}

async function status(args: string[]): Promise<string> {
  parseArgs(STATUS, args);
  const s = authState();
  const server = apiOrigin();
  if (s.state === "signed_out") {
    return compose(toon({ auth: "not signed in", server }), helpBlock([run("auth login", "to sign in (free with a RegAlert account)")]));
  }
  if (s.state === "pending") {
    return compose(
      toon({ auth: "waiting for the approval in a browser", url: s.url, expires_in: minutes(s.expires_at - Date.now()), server }),
      helpBlock(["Open the url in a browser, sign in to RegAlert and approve", run('auth login --callback-url "<address the browser ends on>"', "when the browser is on another machine")]),
    );
  }
  return compose(
    toon({ auth: s.state === "token_from_env" ? "token from REGALERT_TOKEN" : "signed in", server }),
    helpBlock([run("account", "for this account's access")]),
  );
}

async function signOut(args: string[]): Promise<string> {
  parseArgs(LOGOUT, args);
  if ((process.env.REGALERT_TOKEN ?? "").trim()) {
    return toon({ logout: "nothing stored to forget: the token comes from REGALERT_TOKEN (no-op)" });
  }
  const had = await logout();
  return compose(toon({ logout: had ? "signed out" : "already signed out (no-op)" }), helpBlock([run("auth login", "to sign in again")]));
}

async function listen(args: string[]): Promise<string> {
  const { flags: f } = parseArgs(LISTEN, args);
  const port = num(f.port);
  if (!port) throw new UsageError("auth listen is started by `auth login`", "MISSING_VALUE", [run("auth login")]);
  const { done } = await listenForCallback(port);
  return toon({ listen: await done });
}

const SUBCOMMANDS: Record<string, (args: string[]) => Promise<string>> = { login, status, logout: signOut, listen };

const SUB_SPECS: Record<string, CommandSpec> = { login: LOGIN, status: STATUS, logout: LOGOUT };

export async function authCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  // `auth --help` is the index of the three commands; `auth login --help` is that command's own reference.
  if (args.includes("--help")) return (sub && SUB_SPECS[sub] ? helpFor(SUB_SPECS[sub]) : AUTH_HELP).trimEnd();
  const handler = sub ? SUBCOMMANDS[sub] : undefined;
  if (!handler) {
    throw new UsageError(sub ? `unknown auth command \`${sub}\`` : "`auth` needs a command: login, status or logout", "UNKNOWN_COMMAND", [
      run("auth login", "to sign in"),
      run("auth status", "to see the sign-in"),
      run("auth logout", "to forget it"),
    ]);
  }
  return handler(rest);
}

export async function accountCommand(args: string[]): Promise<string> {
  parseArgs(ACCOUNT, args);
  const account = await apiGet<Record<string, unknown>>("/v1/account");
  const s = authState();
  return toon({ ...account, signed_in_with: s.state === "token_from_env" ? "REGALERT_TOKEN" : "the stored sign-in", server: apiOrigin() });
}
