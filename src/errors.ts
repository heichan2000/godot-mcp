/**
 * Structured error responses: { content, isError, possibleSolutions[] }.
 * Kept from the original — agents use possibleSolutions to self-correct.
 */
import type { ToolResult } from "./registry.js";

export function createErrorResponse(
  message: string,
  possibleSolutions: string[] = [],
): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    possibleSolutions,
  };
}
