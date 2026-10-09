/** A stand-in for the RegAlert server and its sign-in server, and a way to run the CLI in-process against it. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  body: string;
}

export type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
export type Route = (call: Call) => Reply | undefined;

export interface Stub {
  url: string;
  calls: Call[];
  /** Replace how the stub answers; a route that returns undefined falls to a 404. */
  route: (fn: Route) => void;
  close: () => Promise<void>;
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

export async function startStub(): Promise<Stub> {
  const calls: Call[] = [];
  let route: Route = () => undefined;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const call: Call = { method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: await read(req) };
    calls.push(call);
    const reply = route(call) ?? { status: 404, json: { error: "not_found", message: `No route ${call.method} ${call.path}.` } };
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    res.writeHead(reply.status ?? 200, { "Content-Type": reply.text !== undefined ? "text/html" : "application/json", ...reply.headers });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    route: (fn) => {
      route = fn;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A fresh, empty config directory for one test; `cleanup` removes it. */
export function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "regalert-axi-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run the CLI in this process: what it printed, and the exit code it set. */
export async function cli(...argv: string[]): Promise<{ out: string; code: number }> {
  let out = "";
  process.exitCode = undefined;
  await main({ argv, stdout: { write: (chunk: string) => (out += chunk) } });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out, code };
}

export const UID = "8b2890f6-3cf4-435d-bb76-63eae73e4ab3";
