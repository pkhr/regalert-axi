/**
 * `setup hooks`: put the home view into an agent's session start (Claude
 * Code, Codex, OpenCode), so a session opens with the newest documents and
 * the commands in view. Only ever done here, on request — no other command
 * touches an agent's settings.
 */
import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { helpFor, parseArgs, type CommandSpec } from "../args.js";
import { CliError, UsageError } from "../errors.js";
import { BIN, compose, helpBlock, run, toon } from "../output.js";

export const SETUP_HOOKS: CommandSpec = {
  name: "setup hooks",
  summary: "Install or repair the session-start hook of Claude Code, Codex and OpenCode: each session then opens with this tool's home view.",
  flags: {
    status: { kind: "boolean", help: "Report where the hook is installed; change nothing" },
    uninstall: { kind: "boolean", help: "Remove the hook this tool installed; other hooks are not touched" },
    project: { kind: "boolean", help: "This repository's agent settings instead of the user's" },
  },
  notes: ["The hook costs about 350 tokens a session. The installable skill (README) costs none until it is used."],
  examples: ["setup hooks", "setup hooks --status", "setup hooks --uninstall", "setup hooks --project"],
};

export const SETUP_HELP = helpFor(SETUP_HOOKS);

const OPTIONS = { marker: BIN, binaryNames: [BIN] };

export async function setupCommand(args: string[]): Promise<string> {
  if (args.includes("--help")) return SETUP_HELP.trimEnd();
  const [sub, ...rest] = args;
  if (sub !== "hooks") {
    throw new UsageError(sub ? `unknown setup command \`${sub}\`` : "`setup` needs a command: hooks", "UNKNOWN_COMMAND", [run("setup hooks", "to install the session-start hook"), run("setup hooks --status")]);
  }
  const { flags: f } = parseArgs(SETUP_HOOKS, rest);
  if (f.status && f.uninstall) throw new UsageError("--status and --uninstall cannot be used together", "CONFLICTING_FLAGS");
  const scope = f.project ? ("project" as const) : ("user" as const);
  const where = f.project ? " --project" : "";

  const report = () => {
    const s = sessionStartHookStatus({ ...OPTIONS, scope });
    return {
      scope,
      claude_code: s.claude.installed ? `installed (${s.claude.path})` : "not installed",
      codex: s.codex.installed ? `installed (${s.codex.path})` : "not installed",
      opencode: s.opencode.installed ? `installed (${s.opencode.path})` : "not installed",
    };
  };

  if (f.status) {
    const r = report();
    const any = [r.claude_code, r.codex, r.opencode].some((x) => x.startsWith("installed"));
    return compose(toon({ hooks: r }), helpBlock([any ? run(`setup hooks --uninstall${where}`, "to remove them") : run(`setup hooks${where}`, "to install them")]));
  }

  const problems: string[] = [];
  if (f.uninstall) {
    uninstallSessionStartHooks({ ...OPTIONS, scope, onError: (m) => problems.push(m) });
    if (problems.length) throw new CliError(`Could not remove the hook: ${problems[0]}`, "HOOK_FAILED");
    return compose(toon({ hooks: { status: "removed (nothing else was changed)", ...report() } }), helpBlock([run(`setup hooks${where}`, "to install them again")]));
  }

  installSessionStartHooks({ ...OPTIONS, scope, onError: (m) => problems.push(m) });
  if (problems.length) throw new CliError(`Could not install the hook: ${problems[0]}`, "HOOK_FAILED", [run(`setup hooks --status${where}`)]);
  const r = report();
  const installed = [r.claude_code, r.codex, r.opencode].some((x) => x.startsWith("installed"));
  if (!installed) {
    // The SDK installs nothing for a run from source or from a one-off npx cache: such a path would not be there next session.
    return compose(
      toon({ hooks: { status: "not installed: this copy of the tool is not at a lasting path", ...r } }),
      helpBlock([`Install it first: \`npm install -g ${BIN}\`, then run \`${BIN} setup hooks${where}\``]),
    );
  }
  return compose(
    toon({ hooks: { status: "installed or already up to date", ...r } }),
    helpBlock(["Start a new agent session to get the home view at its start", run(`setup hooks --uninstall${where}`, "to remove the hook")]),
  );
}
