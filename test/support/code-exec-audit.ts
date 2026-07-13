/**
 * REQ-M-03 code-exec audit (#76): flags inventory entries whose name contains
 * an eval/exec-shaped token. Token-based (split on `_`, `/`, and camelCase
 * boundaries), so run_project and get_script_errors stay clean while
 * execute_expression or run_code_snippet are flagged. A heuristic tripwire,
 * not the guarantee itself - REQ-M-03 is enforced architecturally by the
 * named-op dispatch table having no eval pathway.
 */
const DENY_TOKENS = new Set([
  "eval",
  "exec",
  "execute",
  "expr",
  "expression",
  "shell",
  "cmd",
  "command",
  "code",
  "interpret",
  "interpreter",
  "compile",
  "inject",
]);

export function auditCodeExec(entries: readonly string[]): string[] {
  return entries.filter((entry) =>
    entry
      .split(/[_/]|(?<=[a-z0-9])(?=[A-Z])/)
      .some((token) => DENY_TOKENS.has(token.toLowerCase())),
  );
}

/**
 * Extracts the addon's named-op dispatch table from server.gd's match arms
 * (`"domain/verb":`). Same source-text parsing style as addon-lockstep.test.ts.
 */
export function parseAddonOpTable(serverGdSource: string): string[] {
  return [...serverGdSource.matchAll(/^\s*"([a-z0-9_]+\/[a-z0-9_]+)":/gm)].map(
    (match) => match[1]!,
  );
}
