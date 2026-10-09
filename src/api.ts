/**
 * The REST client. One GET per command (two for a view that joins two), the
 * bearer token from auth.ts, and every way a call can fail turned into an
 * error with the command that fixes it — never the server's raw answer.
 */
import { accessToken, refresh } from "./auth.js";
import { apiOrigin, cachedRoutes, storeRoutes } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { flags, run } from "./output.js";
import { VERSION } from "./version.js";

export type Params = Record<string, string | number | boolean | undefined>;

const TIMEOUT_MS = 30_000;

interface Problem {
  error?: string;
  message?: string;
  suggestions?: Array<Record<string, string | number | null>>;
  hint?: string;
}

function url(path: string, params: Params): string {
  const u = new URL(`${apiOrigin()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === false) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

const UNAVAILABLE = (detail: string): CliError =>
  new CliError(`RegAlert could not be reached (${detail})`, "UNAVAILABLE", ["Run the same command again in a minute"]);

/** A wrong code, as flags to type: the server's suggestions become `--regulator X --jurisdiction Y`. */
function suggestionHelp(code: string, rows: Problem["suggestions"]): string[] {
  if (!rows?.length) return [];
  if (code === "unknown_jurisdiction") return rows.map((r) => `Use \`--jurisdiction ${r.jurisdiction}\` (${r.name})`);
  if (code === "unknown_region") return [`Use one of: ${rows.map((r) => `--region ${r.region}`).join(", ")}`];
  if (code.includes("regulator")) {
    return rows.slice(0, 8).map((r) => `Use \`${flags({ regulator: String(r.code), jurisdiction: code === "unknown_regulator" ? undefined : String(r.jurisdiction) })}\` for ${r.name}${code === "unknown_regulator" ? ` (${r.jurisdiction})` : ""}`);
  }
  return [];
}

/** The server names its inputs (`jurisdiction`, `max_chars`); here they are flags (--jurisdiction, --max-chars). */
const asFlags = (message: string): string =>
  message.replace(/`(regulator|jurisdiction|region|topic|since|until|fields|limit|offset|sort|query|max_chars|include_original|direction|relation)`/g, (_m, name: string) =>
    name === "include_original" ? "--original" : `--${name.replace(/_/g, "-")}`,
  );

function toError(status: number, body: Problem): CliError {
  const code = body.error ?? `http_${status}`;
  const message = asFlags(body.message ?? `RegAlert answered HTTP ${status}`);
  const details = body.suggestions?.length ? { suggestions: body.suggestions } : {};
  if (status === 400) {
    const help = suggestionHelp(code, body.suggestions);
    if (code === "unknown_regulator" && !help.length) help.push(run('regulators --query "<part of the name, or a country>"', "to find the code"));
    if (code === "unknown_topic") help.push(run("topics", "for the topic tags"));
    if (code === "unknown_jurisdiction" && !help.length) help.push(run('regulators --query "<country>"', "to find the jurisdiction code"));
    return new UsageError(message, code.toUpperCase(), help, details);
  }
  if (status === 404 && code === "not_enabled") {
    return new CliError("This server does not offer the search over rule sentences yet", "NOT_ENABLED", [run('search "<words>"', "to search the documents by words")]);
  }
  if (status === 404) return new CliError(message, "NOT_FOUND", [run('search "<words>"', "to find a document and its uid")]);
  if (status === 429) return new CliError(message, "FAIR_USE", ["search, recent, regulators, topics and lineage keep working", run("account", "for this account's access")]);
  if (status === 402) return new CliError(message, "INSUFFICIENT_BALANCE", [run("account", "for the balance and where to add credit")]);
  if (status >= 500) return new CliError("RegAlert could not answer this call just now", "UNAVAILABLE", ["Run the same command again in a minute"]);
  return new CliError(message, code.toUpperCase());
}

async function send(target: string, token: string | null): Promise<Response> {
  try {
    return await fetch(target, {
      headers: { Accept: "application/json", "User-Agent": `regalert-axi/${VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    throw UNAVAILABLE(e.name === "TimeoutError" ? "no answer in 30 seconds" : (e.cause?.code ?? e.message));
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON: a proxy or a bot challenge in front of the server, not the server itself.
    throw UNAVAILABLE(`HTTP ${res.status}, not a RegAlert answer`);
  }
  if (!res.ok) throw toError(res.status, body as Problem);
  return body as T;
}

/** GET a route of the API as the signed-in account. A token the server no longer takes is renewed once. */
export async function apiGet<T>(path: string, params: Params = {}): Promise<T> {
  const target = url(path, params);
  let res = await send(target, await accessToken());
  if (res.status === 401 && !(process.env.REGALERT_TOKEN ?? "").trim()) {
    res = await send(target, (await refresh()).access_token);
  }
  if (res.status === 401) {
    throw new CliError(
      (process.env.REGALERT_TOKEN ?? "").trim() ? "RegAlert does not accept the token in REGALERT_TOKEN" : "The sign-in is no longer valid",
      "NOT_SIGNED_IN",
      [run("auth login", "to sign in again")],
    );
  }
  return parse<T>(res);
}

/**
 * What the server offers, from its public index (`GET /v1`), kept for a day.
 * Some routes exist only on a server where the feature is switched on; the
 * tool shows a command only when its route is there.
 */
export async function serverRoutes(): Promise<string[]> {
  const cached = cachedRoutes();
  if (cached) return cached;
  try {
    const res = await send(`${apiOrigin()}/v1`, null);
    if (!res.ok) return [];
    const body = (await res.json()) as { routes?: unknown };
    const routes = Array.isArray(body.routes) ? body.routes.map(String) : [];
    storeRoutes(routes);
    return routes;
  } catch {
    return [];
  }
}

export const offersObligations = (routes: string[]): boolean => routes.some((r) => r.includes("/v1/obligations"));
