import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const addonDir = path.join(repoRoot, "addon", "godot_mcp");
const srcDir = path.join(repoRoot, "src");

/** Recursively lists files under dir with the given extension. */
function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}

/**
 * REQ-M-07 (#76): zero telemetry. The only network endpoint in the whole
 * system is the addon's loopback bridge; the server's only sockets are the
 * bridge WebSocket and the LSP client, both pinned to 127.0.0.1. Static
 * source audit - a PR that adds a network API fails here, at review time.
 */
describe("no-telemetry audit (REQ-M-07)", () => {
  const gdFiles = walk(addonDir, ".gd");
  const tsFiles = walk(srcDir, ".ts");

  it("found the sources it audits", () => {
    expect(gdFiles.length).toBeGreaterThan(5);
    expect(tsFiles.length).toBeGreaterThan(10);
  });

  it("the addon uses no network API beyond the bridge's TCPServer + WebSocketPeer", () => {
    const deny = [
      "HTTPRequest",
      "HTTPClient",
      "StreamPeerTCP",
      "PacketPeerUDP",
      "UDPServer",
      "ENetMultiplayerPeer",
      "WebSocketMultiplayerPeer",
      "shell_open",
    ];
    for (const file of gdFiles) {
      const source = readFileSync(file, "utf8");
      for (const api of deny) {
        expect(source.includes(api), `${rel(file)} uses denied network API ${api}`).toBe(false);
      }
      if (rel(file) !== "addon/godot_mcp/server.gd") {
        expect(source.includes("TCPServer"), `${rel(file)}: TCPServer outside server.gd`).toBe(
          false,
        );
        expect(
          source.includes("WebSocketPeer"),
          `${rel(file)}: WebSocketPeer outside server.gd`,
        ).toBe(false);
      }
    }
  });

  it("the bridge listens on the loopback literal", () => {
    const serverGd = readFileSync(path.join(addonDir, "server.gd"), "utf8");
    expect(serverGd).toMatch(/\.listen\(port, "127\.0\.0\.1"\)/);
  });

  it("the server imports no HTTP/UDP/TLS module and never calls fetch", () => {
    for (const file of tsFiles) {
      const source = readFileSync(file, "utf8");
      for (const mod of ["node:http", "node:https", "node:dgram", "node:tls"]) {
        expect(source.includes(`"${mod}"`), `${rel(file)} imports ${mod}`).toBe(false);
      }
      expect(/(?<![A-Za-z0-9_])fetch\(/.test(source), `${rel(file)} calls fetch()`).toBe(false);
    }
  });

  it("node:net appears only in the LSP client, which connects to 127.0.0.1", () => {
    for (const file of tsFiles) {
      if (rel(file) === "src/lsp/client.ts") continue;
      expect(
        readFileSync(file, "utf8").includes('"node:net"'),
        `${rel(file)} imports node:net`,
      ).toBe(false);
    }
    const lsp = readFileSync(path.join(srcDir, "lsp", "client.ts"), "utf8");
    expect(lsp).toMatch(/createConnection\(\{ host: "127\.0\.0\.1"/);
  });

  it("every ws:// URL in src is loopback", () => {
    for (const file of tsFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/ws:\/\/[^\s`"']*/g)) {
        expect(
          match[0].startsWith("ws://127.0.0.1"),
          `${rel(file)}: non-loopback ${match[0]}`,
        ).toBe(true);
      }
    }
  });
});
