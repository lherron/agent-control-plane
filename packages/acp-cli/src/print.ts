/**
 * Shared output helpers for acp-cli commands.
 *
 * Lives outside cli.ts so command modules can import output helpers without
 * triggering the commander dispatch guarded by import.meta.main.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
