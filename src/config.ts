/**
 * What the tool keeps on disk, in one directory: the sign-in (tokens, the
 * registered OAuth client, a sign-in that is waiting for the browser) and a
 * small cache of what the server offers. Files are private to the user
 * (0600) and written whole, through a rename, so a reader never sees half a
 * file.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API = "https://mcp.regalert.today";

/** The server this run talks to. `REGALERT_API_URL` is for a local or a staging server. */
export function apiOrigin(): string {
  const raw = (process.env.REGALERT_API_URL ?? "").trim() || DEFAULT_API;
  return raw.replace(/\/+$/, "");
}

export function configDir(): string {
  const explicit = (process.env.REGALERT_AXI_HOME ?? "").trim();
  if (explicit) return explicit;
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  return join(xdg || join(homedir(), ".config"), "regalert-axi");
}

export function readJson<T>(name: string): T | null {
  const path = join(configDir(), name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A damaged file reads as "nothing stored": the next write replaces it.
    return null;
  }
}

export function writeJson(name: string, value: unknown): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function removeFile(name: string): void {
  rmSync(join(configDir(), name), { force: true });
}

// ---- the sign-in, one record per server ------------------------------------

export interface OAuthClient {
  client_id: string;
  /** The loopback address the client was registered with; the browser returns to it. */
  redirect_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  /** Milliseconds since the epoch; absent when the server gave no lifetime. */
  expires_at?: number;
}

/** A sign-in that was started and waits for the person to approve it in a browser. */
export interface PendingLogin {
  state: string;
  verifier: string;
  url: string;
  started_at: number;
  expires_at: number;
}

export interface Credentials {
  client?: OAuthClient;
  tokens?: Tokens;
  pending?: PendingLogin;
}

const CREDENTIALS = "credentials.json";

export function loadCredentials(origin = apiOrigin()): Credentials {
  return readJson<Record<string, Credentials>>(CREDENTIALS)?.[origin] ?? {};
}

/** Read, change, write: `change` gets the record of this server and returns the new one. */
export function updateCredentials(change: (current: Credentials) => Credentials, origin = apiOrigin()): Credentials {
  const all = readJson<Record<string, Credentials>>(CREDENTIALS) ?? {};
  const next = change(all[origin] ?? {});
  all[origin] = next;
  writeJson(CREDENTIALS, all);
  return next;
}

// ---- what the server offers ------------------------------------------------

interface ServerCache {
  fetched_at: number;
  routes: string[];
}

const SERVER = "server.json";
const SERVER_TTL_MS = 24 * 60 * 60_000;

/** The routes the server listed at its last `GET /v1`, or null when never asked / asked more than a day ago. */
export function cachedRoutes(origin = apiOrigin(), now = Date.now()): string[] | null {
  const entry = readJson<Record<string, ServerCache>>(SERVER)?.[origin];
  if (!entry || now - entry.fetched_at > SERVER_TTL_MS) return null;
  return entry.routes;
}

/** The last known routes, however old: for text that must not wait for the network (the help). */
export function knownRoutes(origin = apiOrigin()): string[] {
  return readJson<Record<string, ServerCache>>(SERVER)?.[origin]?.routes ?? [];
}

export function storeRoutes(routes: string[], origin = apiOrigin(), now = Date.now()): void {
  const all = readJson<Record<string, ServerCache>>(SERVER) ?? {};
  all[origin] = { fetched_at: now, routes };
  writeJson(SERVER, all);
}
