/**
 * `setup hooks`, with the built binary, in a throw-away project and a
 * throw-away home: the hook is written only on request, a second run changes
 * nothing, and removal takes out this tool's entry and no other.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../dist/bin/regalert-axi.js", import.meta.url));

let project: string;
let home: string;

const bin = (...args: string[]) => run(process.execPath, [BIN, ...args], { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") }, timeout: 15_000 });
const settings = () => JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
const commands = () => settings().hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error("dist/ is missing: run `npm run build` (or `npm test`, which builds first)");
  project = mkdtempSync(join(tmpdir(), "regalert-axi-project-"));
  home = mkdtempSync(join(tmpdir(), "regalert-axi-home-"));
  // Someone else's hook is already there.
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool context" }] }] } }, null, 2));
});
afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("setup hooks", () => {
  it("--status reports and writes nothing", async () => {
    const before = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    const { stdout } = await bin("setup", "hooks", "--status", "--project");
    expect(stdout).toMatch(/^hooks:\n  scope: project\n  claude_code: not installed\n  codex: not installed\n  opencode: not installed\nhelp\[1\]:\n  Run `regalert-axi setup hooks --project` to install them\n$/);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(before);
  });

  it("installs on request, next to the hook that was there; a second run changes nothing", async () => {
    const { stdout } = await bin("setup", "hooks", "--project");
    expect(stdout).toMatch(/^hooks:\n  status: installed or already up to date\n  scope: project\n  claude_code: "?installed \(/);
    expect(commands().some((c) => c.includes("regalert-axi"))).toBe(true);
    expect(commands()).toContain("other-tool context");

    const first = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    await bin("setup", "hooks", "--project");
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(first);
    expect(commands().filter((c) => c.includes("regalert-axi")).length).toBe(1);
  });

  it("--uninstall removes this tool's entry and leaves the other", async () => {
    const { stdout } = await bin("setup", "hooks", "--uninstall", "--project");
    expect(stdout).toMatch(/^hooks:\n  status: removed \(nothing else was changed\)\n  scope: project\n  claude_code: not installed\n/);
    expect(commands()).toEqual(["other-tool context"]);
  });

  it("no other command writes an agent's settings", async () => {
    const before = readFileSync(join(project, ".claude", "settings.json"), "utf8");
    await bin("--help");
    await bin("auth", "status");
    await bin();
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe(before);
  });

  it("an unknown setup command and contradicting flags are usage errors", async () => {
    await expect(bin("setup", "everything")).rejects.toMatchObject({ code: 2 });
    await expect(bin("setup", "hooks", "--status", "--uninstall")).rejects.toMatchObject({ code: 2 });
  });
});
