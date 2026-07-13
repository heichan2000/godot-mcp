import { existsSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRawClient, type RawBridgeClient } from "./raw-client.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  warnSkippedCoverage,
  type EditorHandle,
} from "./support.js";

/**
 * REQ-M-01 addon layer in isolation (#76): a raw WebSocket client - zero TS
 * server code - sends escaping paths straight to the live editor's bridge.
 * Every op must answer with a structured error, and nothing may appear on
 * disk outside the project. Also hosts the REQ-M-07 runtime loopback assert.
 */
const RAW_ESCAPES = [
  "res://../../escaped_by_test.tscn",
  "../../escaped_by_test.tscn",
  "/etc/passwd",
];

describe.runIf(hasGodot)("addon-layer containment via raw bridge client (REQ-M-01)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let client: RawBridgeClient;
  let port: number;

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    port = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir);
    client = await connectRawClient(port);
  }, 240_000);

  afterAll(async () => {
    client?.close();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  function assertNoEscapeArtifacts(): void {
    // Both relative escapes resolve two levels above the project dir.
    expect(existsSync(path.resolve(projectDir, "../../escaped_by_test.tscn"))).toBe(false);
    expect(existsSync(path.resolve(projectDir, "../escaped_by_test.tscn"))).toBe(false);
  }

  // Ops whose addon re-check exists today: expect the addon's own path_escape.
  const GUARDED: Array<{ op: string; params: (escape: string) => Record<string, unknown> }> = [
    { op: "scene/create", params: (escape) => ({ scene_path: escape, root_node_type: "Node2D" }) },
    { op: "scene/open", params: (escape) => ({ scene_path: escape }) },
    { op: "run/play", params: (escape) => ({ mode: "custom", scene_path: escape }) },
    {
      op: "scene/export_mesh_library",
      params: (escape) => ({ scene_path: escape, output_path: "res://out.res" }),
    },
    {
      op: "scene/export_mesh_library",
      params: (escape) => ({ scene_path: "res://ignored.tscn", output_path: escape }),
    },
  ];

  for (const { op, params } of GUARDED) {
    it(`${op} rejects every escape shape with path_escape`, async () => {
      for (const escape of RAW_ESCAPES) {
        const reply = await client.request(op, params(escape));
        expect(reply.result, `${op} accepted ${escape}`).toBeUndefined();
        expect(reply.error?.code, `${op} on ${escape}`).toBe("path_escape");
        expect(reply.error?.possibleSolutions?.length).toBeGreaterThan(0);
      }
      assertNoEscapeArtifacts();
    }, 60_000);
  }

  // scene/save and scene/close reject escapes structurally: an escaping path
  // can never name an open scene. Pin that this stays an error, never a write.
  for (const op of ["scene/save", "scene/close"]) {
    it(`${op} answers an escaping scene_path with a structured error`, async () => {
      for (const escape of RAW_ESCAPES) {
        const reply = await client.request(op, { scene_path: escape });
        expect(reply.result, `${op} accepted ${escape}`).toBeUndefined();
        expect(reply.error?.code).toBeTruthy();
        expect(reply.error?.possibleSolutions?.length).toBeGreaterThan(0);
      }
      assertNoEscapeArtifacts();
    }, 60_000);
  }

  it("the bridge port refuses non-loopback connections (REQ-M-07)", async () => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && !iface.internal && iface.family === "IPv4");
    if (!external) {
      warnSkippedCoverage("non-loopback bind refusal", "runner has no non-loopback IPv4 interface");
      return;
    }
    await expect(
      new Promise<void>((resolve, reject) => {
        const probe = netConnect({ host: external.address, port, timeout: 3_000 });
        probe.once("connect", () => {
          probe.destroy();
          resolve(); // connecting via a non-loopback address = the bug
        });
        probe.once("error", () => reject(new Error("refused")));
        probe.once("timeout", () => {
          probe.destroy();
          reject(new Error("refused (timeout)"));
        });
      }),
    ).rejects.toThrow("refused");
  }, 30_000);
});
