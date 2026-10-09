/**
 * Errors an agent can act on: a sentence, a stable code, and the commands
 * that fix it. They are printed on stdout in the same form as normal output
 * (cli.ts), never as a stack trace.
 *
 * Exit codes: 0 success (also "nothing found" and no-ops), 1 an error,
 * 2 a usage error — the call itself is wrong (an unknown flag, a missing
 * argument, a code the server does not know).
 */
import { AxiError } from "axi-sdk-js";

export { AxiError };

/** Rows that belong to an error, e.g. the regulators a wrong code probably meant. */
export type ErrorDetails = Record<string, unknown>;

export class CliError extends AxiError {
  constructor(
    message: string,
    code: string,
    help: string[] = [],
    public readonly details: ErrorDetails = {},
  ) {
    super(message, code, help);
    this.name = "CliError";
  }
}

/** The call is wrong and can be corrected by the caller: exit 2. */
export class UsageError extends CliError {
  constructor(message: string, code: string, help: string[] = [], details: ErrorDetails = {}) {
    super(message, code, help, details);
    this.name = "UsageError";
  }
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return 2;
  // The SDK marks its own usage errors (a flag before the command, …) this way.
  if (error instanceof AxiError && error.code === "VALIDATION_ERROR") return 2;
  return 1;
}
