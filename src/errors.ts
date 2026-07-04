export interface CreateErrorResponseInput {
  message: string;
  possibleSolutions?: string[];
}

export interface ErrorResponse {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    message: string;
    possibleSolutions: string[];
  };
}

/**
 * Builds a structured, guided MCP tool error result.
 *
 * MCP `CallToolResult` has no custom top-level fields, so `possibleSolutions`
 * travels inside `content` (as human-readable text) and `structuredContent`
 * (for programmatic consumers), alongside `isError: true`.
 */
export function createErrorResponse({
  message,
  possibleSolutions = [],
}: CreateErrorResponseInput): ErrorResponse {
  const lines = [message];
  if (possibleSolutions.length > 0) {
    lines.push("", "Possible solutions:");
    for (const solution of possibleSolutions) {
      lines.push(`- ${solution}`);
    }
  }

  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { message, possibleSolutions },
  };
}
