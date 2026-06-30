/**
 * Tool registry: define each tool once, derive MCP list + dispatch.
 *
 * defineTool({ name, description, input, handler }) registers a descriptor.
 * The server derives the MCP `inputSchema` from the zod `input` and routes
 * CallTool by name to `handler`. Adding a tool = one file, registered once.
 *
 * TODO(M1): implement zod → JSON Schema conversion for inputSchema, and
 * the dispatch path (validate args with input, call handler, shape result).
 */
import type { z } from "zod";

export interface ToolContext {
  // TODO(M1): config, godot path resolver, process manager, logger.
  [key: string]: unknown;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  possibleSolutions?: string[];
}

export interface ToolDescriptor<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: S;
  /** Only registered tools whose `gated` predicate passes are exposed. */
  gated?: (ctx: ToolContext) => boolean;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

class Registry {
  private readonly tools = new Map<string, ToolDescriptor>();

  define<S extends z.ZodTypeAny>(descriptor: ToolDescriptor<S>): void {
    if (this.tools.has(descriptor.name)) {
      throw new Error(`duplicate tool registration: ${descriptor.name}`);
    }
    this.tools.set(descriptor.name, descriptor as ToolDescriptor);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }
}

export const registry = new Registry();

export function defineTool<S extends z.ZodTypeAny>(
  descriptor: ToolDescriptor<S>,
): void {
  registry.define(descriptor);
}
