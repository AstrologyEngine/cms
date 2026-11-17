/** A CLI failure with its exit code: 1 refused, 2 could not run. */
export type CliError = Error & { name: "CliError"; exitCode: 1 | 2 };

export const cliError = (exitCode: 1 | 2, message: string): CliError =>
  Object.assign(new Error(message), { name: "CliError" as const, exitCode });

export const isCliError = (error: unknown): error is CliError =>
  error instanceof Error &&
  error.name === "CliError" &&
  "exitCode" in error &&
  (error.exitCode === 1 || error.exitCode === 2);
