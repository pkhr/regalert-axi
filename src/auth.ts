/**
 * Sign-in: OAuth 2.1 authorization code with PKCE, as a public client that
 * registers itself (RFC 7591) and returns through a loopback address
 * (RFC 8252) — the way an MCP client signs in to the same server.
 *
 * A sign-in needs a person and a browser, and an agent cannot wait inside one
 * command for either. So `auth login` does not wait: it starts a small
 * listener in the background, prints the address to open, and returns. When
 * the person approves, the listener takes the code, gets the tokens, stores
 * them and stops. The next command just works. On a machine with no browser
 * the address the browser ends on is handed back with `--callback-url`.
 *
 * `REGALERT_TOKEN` skips all of it: the value is sent as the bearer token.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { apiOrigin, loadCredentials, updateCredentials, type OAuthClient, type PendingLogin, type Tokens } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { run } from "./output.js";

const SCOPE = "profile email offline_access";
/** The first port tried for the loopback address; another free one is taken when it is in use. */
export const DEFAULT_PORT = 53682;
/** How long a started sign-in waits for the browser. */
export const LOGIN_TTL_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;

const b64url = (buf: Buffer): string => buf.toString("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export interface AuthServer {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
}

/** Where to sign in, as the API says it (RFC 9728, then RFC 8414). */
export async function discover(origin = apiOrigin()): Promise<AuthServer> {
  try {
    const resource = await getJson(`${origin}/.well-known/oauth-protected-resource`);
    const issuer = String((resource.authorization_servers as unknown[] | undefined)?.[0] ?? "").replace(/\/+$/, "");
    if (!issuer) throw new Error("the server names no authorization server");
    const meta = await getJson(`${issuer}/.well-known/oauth-authorization-server`);
    const need = (key: string): string => {
      const v = meta[key];
      if (typeof v !== "string" || !v) throw new Error(`the authorization server gives no ${key}`);
      return v;
    };
    return {
      authorization_endpoint: need("authorization_endpoint"),
      token_endpoint: need("token_endpoint"),
      registration_endpoint: need("registration_endpoint"),
      revocation_endpoint: typeof meta.revocation_endpoint === "string" ? meta.revocation_endpoint : undefined,
    };
  } catch (err) {
    throw new CliError(`Could not find out how to sign in to ${origin}: ${(err as Error).message}`, "UNAVAILABLE", ["Run the same command again in a minute"]);
  }
}

async function register(server: AuthServer, redirectUri: string): Promise<OAuthClient> {
  const res = await fetch(server.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "RegAlert CLI (regalert-axi)",
      client_uri: "https://github.com/pkhr/regalert-axi",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.client_id !== "string") {
    throw new CliError(
      `The sign-in server did not register this tool (HTTP ${res.status}${body.error_description ? `: ${String(body.error_description).slice(0, 160)}` : ""})`,
      "REGISTRATION_FAILED",
      ["Run the same command again in a minute"],
    );
  }
  return {
    client_id: body.client_id,
    redirect_uri: redirectUri,
    authorization_endpoint: server.authorization_endpoint,
    token_endpoint: server.token_endpoint,
    revocation_endpoint: server.revocation_endpoint,
  };
}

const redirectFor = (port: number): string => `http://127.0.0.1:${port}/callback`;
export const portOf = (redirectUri: string): number => Number(new URL(redirectUri).port);

/** True when nothing listens on the port yet. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export function authorizeUrl(client: OAuthClient, state: string, challenge: string, origin = apiOrigin()): string {
  const url = new URL(client.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // RFC 8707: the token is for this API and no other.
    resource: `${origin}/`,
  })) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Start a sign-in: a registered client whose loopback port is free (the one
 * kept from last time, or a new registration), a fresh state and verifier,
 * and the address to open. Stored, so another process can finish it.
 */
export async function beginLogin(preferredPort?: number, now = Date.now()): Promise<{ client: OAuthClient; pending: PendingLogin }> {
  let client = loadCredentials().client;
  if (client && (preferredPort ? portOf(client.redirect_uri) !== preferredPort : false)) client = undefined;
  // The port is taken: by this tool's own listener from an earlier sign-in (it serves the new one too), or by something else.
  if (client && !(await portIsFree(portOf(client.redirect_uri))) && !(await listenerIsUp(portOf(client.redirect_uri)))) client = undefined;
  if (!client) {
    const wanted = preferredPort ?? DEFAULT_PORT;
    const port = (await portIsFree(wanted)) ? wanted : preferredPort ? 0 : await freePort();
    if (!port) throw new UsageError(`Port ${wanted} is in use on this machine`, "PORT_IN_USE", ["Leave --port out: a free port is then taken"]);
    client = await register(await discover(), redirectFor(port));
  }
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const pending: PendingLogin = { state, verifier, url: authorizeUrl(client, state, challenge), started_at: now, expires_at: now + LOGIN_TTL_MS };
  const kept = client;
  updateCredentials((c) => ({ ...c, client: kept, pending }));
  return { client, pending };
}

async function tokenRequest(client: OAuthClient, form: Record<string, string>, now = Date.now()): Promise<Tokens> {
  const res = await fetch(client.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: client.client_id, ...form }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const why = [body.error, body.error_description].filter((x) => typeof x === "string").join(": ");
    throw new CliError(`The sign-in server refused (HTTP ${res.status}${why ? `, ${why.slice(0, 200)}` : ""})`, "SIGN_IN_REFUSED", [run("auth login", "to sign in again")]);
  }
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : form.refresh_token,
    expires_at: typeof body.expires_in === "number" ? now + body.expires_in * 1000 : undefined,
  };
}

/** Trade the code the browser came back with for tokens, and store them. */
export async function finishLogin(code: string, state: string): Promise<void> {
  const { client, pending } = loadCredentials();
  if (!client || !pending) throw new CliError("No sign-in is waiting", "NO_PENDING_LOGIN", [run("auth login", "to start one")]);
  if (state !== pending.state) throw new CliError("This address belongs to another sign-in (the state does not match)", "STATE_MISMATCH", [run("auth login", "to start again")]);
  if (Date.now() > pending.expires_at) throw new CliError("The sign-in was started more than 10 minutes ago", "LOGIN_EXPIRED", [run("auth login", "to start again")]);
  const tokens = await tokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: client.redirect_uri, code_verifier: pending.verifier });
  updateCredentials((c) => ({ client: c.client, tokens }));
}

/** `--callback-url`: the address the browser ended on, copied by hand from a machine that cannot reach this one. */
export async function finishFromCallbackUrl(address: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new UsageError("--callback-url must be the whole address the browser ended on (it starts with http://127.0.0.1)", "BAD_VALUE");
  }
  const error = url.searchParams.get("error");
  if (error) throw new CliError(`The sign-in was not approved: ${url.searchParams.get("error_description") ?? error}`, "SIGN_IN_REFUSED", [run("auth login", "to start again")]);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new UsageError("That address holds no `code` and `state`: copy it after the approval, with everything after the `?`", "BAD_VALUE");
  await finishLogin(code, state);
}

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${text}</p></body>`;

/** What the listener answers on `/ready`: how a later command knows the port holds this tool's listener and nothing else. */
const READY = "regalert-axi ready";

async function listenerIsUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) });
    return res.ok && (await res.text()) === READY;
  } catch {
    return false;
  }
}

/**
 * The listener the browser returns to. It answers `/ready` (so the command
 * that started it knows it is up), takes the `/callback` of the sign-in that
 * is waiting, finishes it and stops. It lives as long as a sign-in waits: it
 * reads the record every `pollMs` and stops when the record is gone (signed
 * out, or never approved in time). A sign-in started again meanwhile is
 * served by the same listener.
 */
export function listenForCallback(port: number, pollMs = 2_000): Promise<{ server: Server; done: Promise<"signed_in" | "failed" | "expired"> }> {
  return new Promise((resolve, reject) => {
    let finish: (outcome: "signed_in" | "failed" | "expired") => void = () => {};
    const done = new Promise<"signed_in" | "failed" | "expired">((r) => {
      finish = r;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/ready") return void res.writeHead(200, { "Content-Type": "text/plain" }).end(READY);
      if (url.pathname !== "/callback") return void res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      // A request that is not the answer to THIS sign-in (a stray visit, an old tab) must not end the wait.
      const answers = url.searchParams.get("state") === loadCredentials().pending?.state;
      if (!answers) return void res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Not this sign-in", "This address does not belong to the sign-in that is waiting."));
      finishFromCallbackUrl(url.toString()).then(
        () => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Signed in", "regalert-axi is signed in to RegAlert. You can close this tab."));
          finish("signed_in");
        },
        (err: unknown) => {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Sign-in failed", `${(err as Error).message.replace(/[<>&]/g, "")} Run <code>regalert-axi auth login</code> again.`));
          // The code is spent: nothing waits any more, and `auth status` must not say that something does.
          updateCredentials((c) => ({ client: c.client, tokens: c.tokens }));
          finish("failed");
        },
      );
    });
    const timer = setInterval(() => {
      const waiting = loadCredentials().pending;
      if (!waiting || Date.now() > waiting.expires_at) finish("expired");
    }, pollMs);
    void done.then(() => {
      clearInterval(timer);
      server.close();
      server.closeAllConnections?.();
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, done }));
  });
}

/**
 * Start the listener as a process of its own, so the command that started
 * the sign-in can return at once. True when it answers on its port.
 */
export async function spawnListener(port: number): Promise<boolean> {
  if (await listenerIsUp(port)) return true;
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "auth", "listen", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await listenerIsUp(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export type AuthState =
  | { state: "token_from_env" }
  | { state: "signed_in"; expires_at?: number }
  | { state: "pending"; url: string; expires_at: number }
  | { state: "signed_out" };

export function authState(now = Date.now()): AuthState {
  if ((process.env.REGALERT_TOKEN ?? "").trim()) return { state: "token_from_env" };
  const { tokens, pending } = loadCredentials();
  if (tokens?.access_token) return { state: "signed_in", expires_at: tokens.expires_at };
  if (pending && now < pending.expires_at) return { state: "pending", url: pending.url, expires_at: pending.expires_at };
  return { state: "signed_out" };
}

const NOT_SIGNED_IN = (): CliError => {
  const s = authState();
  if (s.state === "pending") {
    return new CliError("The sign-in is not approved yet", "SIGN_IN_PENDING", [
      `Open ${s.url} in a browser, sign in to RegAlert and approve`,
      run('auth login --callback-url "<address the browser ends on>"', "when the browser is on another machine"),
    ]);
  }
  return new CliError("Not signed in to RegAlert", "NOT_SIGNED_IN", [run("auth login", "to sign in (free with a RegAlert account)"), "Or set REGALERT_TOKEN to a bearer token"]);
};

/** The bearer token for a call; a stored token that is about to expire is renewed first. */
export async function accessToken(now = Date.now()): Promise<string> {
  const fromEnv = (process.env.REGALERT_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const { client, tokens } = loadCredentials();
  if (!tokens?.access_token) throw NOT_SIGNED_IN();
  if (tokens.expires_at && tokens.expires_at - 60_000 < now && tokens.refresh_token && client) return (await refresh()).access_token;
  return tokens.access_token;
}

/** A new access token from the refresh token; signed out when the server refuses it. */
export async function refresh(): Promise<Tokens> {
  const { client, tokens } = loadCredentials();
  if (!client || !tokens?.refresh_token) {
    updateCredentials((c) => ({ client: c.client }));
    throw new CliError("The sign-in has expired", "NOT_SIGNED_IN", [run("auth login", "to sign in again")]);
  }
  try {
    const next = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    updateCredentials((c) => ({ ...c, tokens: next }));
    return next;
  } catch (err) {
    // A refused refresh token will not work the next time either; a network failure may.
    if (err instanceof CliError && err.code === "SIGN_IN_REFUSED") {
      updateCredentials((c) => ({ client: c.client }));
      throw new CliError("The sign-in has expired", "NOT_SIGNED_IN", [run("auth login", "to sign in again")]);
    }
    throw new CliError("The sign-in server could not be reached to renew the sign-in", "UNAVAILABLE", ["Run the same command again in a minute"]);
  }
}

/** Forget the tokens (and tell the server, when it can be told). The registered client is kept for the next sign-in. */
export async function logout(): Promise<boolean> {
  const { client, tokens } = loadCredentials();
  const had = !!tokens?.access_token;
  if (client?.revocation_endpoint && tokens?.refresh_token) {
    await fetch(client.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, token: tokens.refresh_token, token_type_hint: "refresh_token" }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch(() => undefined);
  }
  updateCredentials((c) => ({ client: c.client }));
  return had;
}
