import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { renderToolDocs } from "../src/docs/tool-docs.js";
import { SERVER_VERSION, buildToolGroups } from "../src/server.js";
import type { BridgePort } from "../src/tools/bridge.js";

// A stub bridge: descriptors capture it but the generator never calls a tool,
// so no editor or socket is needed. Same shape the unit suites use.
const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("stub bridge - docs generation never calls tools");
  },
  traffic: () => [],
};

const outputPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "tools.md",
);

const raw = renderToolDocs(buildToolGroups({ bridge: stubBridge }));
// Format with the repo's Prettier config so `prettier --check .` and the CI
// drift gate agree on one canonical form.
const prettierOptions = await resolveConfig(outputPath);
const formatted = await format(raw, { ...prettierOptions, parser: "markdown" });
writeFileSync(outputPath, formatted, "utf8");
console.log(`wrote ${path.relative(process.cwd(), outputPath)} (${formatted.length} bytes)`);
