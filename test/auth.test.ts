/** The sign-in against a stand-in sign-in server: registration, the address to open, the browser's return, renewal, sign-out. */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { apiGet } from "../src/api.js";
import { accessToken, authState, beginLogin, finishFromCallbackUrl, listenForCallback, pkce, portOf } from "../src/auth.js";
import { loadCredentials, updateCredentials } from "../src/config.js";
import { CliError, UsageError } from "../src/errors.js";
import { cli, startStub, tempHome, type Call, type Stub } from "./helpers.js";

const run = promisify(execFile);

let stub: Stub;
let home: { dir: string; cleanup: () => void };
/** What the stand-in token endpoint answers next. */
let tokenReply: (call: Call) => { status?: number; json: unknown };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());

beforeEach(() => {
  home = tempHome();
  process.env.REGALERT_AXI_HOME = home.dir;
  process.env.REGALERT_API_URL = stub.url;
  delete process.env.REGALERT_TOKEN;
  stub.calls.length = 0;
  tokenReply = () => ({ json: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" } });
  stub.route((c) => {
    if (c.path === "/.well-known/oauth-protected-resource") return { json: { resource: `${stub.url}/`, authorization_servers: [stub.url] } };
    if (c.path === "/.well-known/oauth-authorization-server") {
      return { json: { authorization_endpoint: `${stub.url}/authorize`, token_endpoint: `${stub.url}/token`, registration_endpoint: `${stub.url}/register`, revocation_endpoint: `${stub.url}/revoke` } };
    }
    if (c.path === "/register") return { status: 201, json: { client_id: "client-1" } };
    if (c.path === "/token") return tokenReply(c);
    if (c.path === "/revoke") return { json: {} };
    if (c.path === "/v1/topics") return c.auth === "Bearer access-2" || c.auth === "Bearer access-1" ? { json: { total: 0, topics: [] } } : { status: 401, json: { error: "unauthorized", message: "…" } };
    if (c.path === "/v1/account") return { json: { access: "free", full_text_reads: "available", bulk_access: false, note: "" } };
    return undefined;
  });
});
afterEach(() => home.cleanup());

const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));

describe("starting a sign-in", () => {
  it("registers a public client for one loopback address and builds the address to open, with PKCE", async () => {
    const port = await freePort();
    const { client, pending } = await beginLogin(port);
    const reg = JSON.parse(stub.calls.find((c) => c.path === "/register")!.body) as Record<string, unknown>;
    expect(reg.redirect_uris).toEqual([`http://127.0.0.1:${port}/callback`]);
    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(client).toMatchObject({ client_id: "client-1", redirect_uri: `http://127.0.0.1:${port}/callback`, token_endpoint: `${stub.url}/token` });

    const url = new URL(pending.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${stub.url}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      code_challenge_method: "S256",
      state: pending.state,
      scope: "profile email offline_access",
      // the token is asked for this API and no other
      resource: `${stub.url}/`,
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the verifier stays on this machine
    expect(pending.url).not.toContain(pending.verifier);
    expect(authState()).toMatchObject({ state: "pending", url: pending.url });
  });

  it("the second sign-in uses the client that is already registered", async () => {
    const port = await freePort();
    await beginLogin(port);
    await beginLogin(port);
    expect(stub.calls.filter((c) => c.path === "/register").length).toBe(1);
  });

  it("pkce: the challenge is the SHA-256 of the verifier, both URL-safe", () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce().verifier).not.toBe(verifier);
  });
});

describe("the browser's return", () => {
  it("the listener ignores a visit that is not the answer, then trades the code for tokens and stops", async () => {
    const port = await freePort();
    const { pending } = await beginLogin(port);
    const { done } = await listenForCallback(port, 50);

    expect(await (await fetch(`http://127.0.0.1:${port}/ready`)).text()).toBe("regalert-axi ready");
    const stray = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=someone-else`);
    expect(stray.status).toBe(400);
    expect(authState().state).toBe("pending");

    const back = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${pending.state}`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Signed in");
    expect(await done).toBe("signed_in");

    const sent = form(stub.calls.find((c) => c.path === "/token")!);
    expect(sent).toEqual({ client_id: "client-1", grant_type: "authorization_code", code: "the-code", redirect_uri: `http://127.0.0.1:${port}/callback`, code_verifier: pending.verifier });
    const stored = loadCredentials();
    expect(stored.tokens).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    expect(stored.pending).toBeUndefined();
    expect(authState().state).toBe("signed_in");
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
  });

  it("a refused code ends the wait: nothing is left that says a sign-in is waiting", async () => {
    const port = await freePort();
    const { pending } = await beginLogin(port);
    tokenReply = () => ({ status: 400, json: { error: "invalid_grant", error_description: "The code has expired" } });
    const { done } = await listenForCallback(port, 50);
    const back = await fetch(`http://127.0.0.1:${port}/callback?code=old&state=${pending.state}`);
    expect(back.status).toBe(400);
    expect(await done).toBe("failed");
    expect(authState().state).toBe("signed_out");
  });

  it("the listener stops by itself when the sign-in is given up", async () => {
    const port = await freePort();
    await beginLogin(port);
    const { done } = await listenForCallback(port, 30);
    updateCredentials((c) => ({ client: c.client }));
    expect(await done).toBe("expired");
  });

  it("--callback-url finishes by hand, and refuses an address that is not the answer", async () => {
    const port = await freePort();
    const { pending } = await beginLogin(port);
    await expect(finishFromCallbackUrl("not a url")).rejects.toBeInstanceOf(UsageError);
    await expect(finishFromCallbackUrl(`http://127.0.0.1:${port}/callback`)).rejects.toThrow(/holds no `code` and `state`/);
    await expect(finishFromCallbackUrl(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=The+user+said+no`)).rejects.toThrow(/not approved: The user said no/);
    await expect(finishFromCallbackUrl(`http://127.0.0.1:${port}/callback?code=c&state=other`)).rejects.toThrow(/another sign-in/);

    const done = await cli("auth", "login", "--callback-url", `http://127.0.0.1:${port}/callback?code=by-hand&state=${pending.state}`);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/^login: signed in\nhelp\[2\]:/);
    expect(form(stub.calls.filter((c) => c.path === "/token").at(-1)!).code).toBe("by-hand");
  });
});

describe("a stored sign-in", () => {
  const signedIn = (expiresAt: number) =>
    updateCredentials(() => ({
      client: { client_id: "client-1", redirect_uri: "http://127.0.0.1:1/callback", authorization_endpoint: `${stub.url}/authorize`, token_endpoint: `${stub.url}/token`, revocation_endpoint: `${stub.url}/revoke` },
      tokens: { access_token: "access-1", refresh_token: "refresh-1", expires_at: expiresAt },
    }));

  it("a token that is about to expire is renewed before the call", async () => {
    signedIn(Date.now() + 5_000);
    tokenReply = () => ({ json: { access_token: "access-2", expires_in: 3600 } });
    expect(await accessToken()).toBe("access-2");
    expect(form(stub.calls.find((c) => c.path === "/token")!)).toEqual({ client_id: "client-1", grant_type: "refresh_token", refresh_token: "refresh-1" });
    // the server sent no new refresh token: the old one is kept
    expect(loadCredentials().tokens).toMatchObject({ access_token: "access-2", refresh_token: "refresh-1" });
  });

  it("a token the server stopped taking is renewed once, and the call is sent again", async () => {
    signedIn(Date.now() + 3_600_000);
    updateCredentials((c) => ({ ...c, tokens: { ...c.tokens!, access_token: "stale" } }));
    tokenReply = () => ({ json: { access_token: "access-2", expires_in: 3600 } });
    await expect(apiGet("/v1/topics")).resolves.toEqual({ total: 0, topics: [] });
    expect(stub.calls.filter((c) => c.path === "/v1/topics").map((c) => c.auth)).toEqual(["Bearer stale", "Bearer access-2"]);
  });

  it("a refused renewal signs out, and the error names the way back in", async () => {
    signedIn(Date.now() - 1_000);
    tokenReply = () => ({ status: 400, json: { error: "invalid_grant" } });
    const r = await cli("topics");
    expect(r.code).toBe(1);
    expect(r.out).toBe("error: The sign-in has expired\ncode: NOT_SIGNED_IN\nhelp[1]:\n  Run `regalert-axi auth login` to sign in again\n");
    expect(loadCredentials().tokens).toBeUndefined();
    // the registered client is kept for the next sign-in
    expect(loadCredentials().client?.client_id).toBe("client-1");
  });

  it("status, account and logout; a second logout and a login while signed in are no-ops with exit 0", async () => {
    signedIn(Date.now() + 3_600_000);
    expect((await cli("auth", "status")).out).toMatch(/^auth: signed in\nserver: /);
    expect((await cli("account")).out).toMatch(/^access: free\nfull_text_reads: available\nbulk_access: false\nnote: ""\nsigned_in_with: the stored sign-in\n/);
    const again = await cli("auth", "login");
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/^login: already signed in \(no-op\)/);

    const out = await cli("auth", "logout");
    expect(out.out).toMatch(/^logout: signed out/);
    expect(form(stub.calls.find((c) => c.path === "/revoke")!)).toMatchObject({ token: "refresh-1", client_id: "client-1" });
    const twice = await cli("auth", "logout");
    expect(twice.code).toBe(0);
    expect(twice.out).toMatch(/^logout: already signed out \(no-op\)/);
    expect((await cli("auth", "status")).out).toMatch(/^auth: not signed in/);
  });

  it("with nothing stored a command says how to sign in; with a sign-in waiting it says where to approve", async () => {
    const none = await cli("topics");
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/^error: Not signed in to RegAlert\ncode: NOT_SIGNED_IN\nhelp\[2\]:\n  Run `regalert-axi auth login` to sign in/);
    const { pending } = await beginLogin(await freePort());
    const waiting = await cli("topics");
    expect(waiting.out).toContain("code: SIGN_IN_PENDING");
    expect(waiting.out).toContain(`Open ${pending.url} in a browser`);
  });

  it("an unknown auth command is a usage error; `auth` alone too", async () => {
    for (const args of [["auth"], ["auth", "whoami"]]) {
      const r = await cli(...args);
      expect(r.code).toBe(2);
      expect(r.out).toContain("code: UNKNOWN_COMMAND");
    }
    expect(new CliError("x", "Y")).toBeInstanceOf(Error);
  });
});

describe("the real binary", () => {
  const bin = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "bin/regalert-axi.ts", ...args], { env: { ...process.env, REGALERT_AXI_HOME: home.dir, REGALERT_API_URL: stub.url }, timeout: 15_000 });

  it("`auth login` returns at once with the address, and the sign-in completes in the background when the browser returns", async () => {
    const port = await freePort();
    const started = await bin("auth", "login", "--port", String(port));
    expect(started.stdout).toMatch(/^login: waiting for the approval in a browser\nurl: /);
    const url = new URL(/url: "?([^"\n]+)"?/.exec(started.stdout)![1]);
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/callback`);

    // What the browser does after the approval.
    const back = await fetch(`http://127.0.0.1:${port}/callback?code=real-code&state=${url.searchParams.get("state")}`);
    expect(back.status).toBe(200);

    const status = await bin("auth", "status");
    expect(status.stdout).toMatch(/^auth: signed in\n/);
    const answer = await bin("topics");
    expect(answer.stdout).toMatch(/^count: 0 of 0 total\n/);
    // The background listener is gone.
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
  });

  it("--version answers without loading the commands", async () => {
    const { stdout } = await bin("--version");
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
