/**
 * The single success-result shape every tool descriptor returns: a JSON text
 * block for MCP clients that only read `content`, plus `structuredContent`
 * for clients that consume typed output. Hoisted here (was duplicated in
 * bridge.ts and onboarding.ts) so every tool file shares one definition.
 */
export function successResult(label: string, payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `${label}: ${JSON.stringify(payload)}` }],
    structuredContent: payload,
  };
}
