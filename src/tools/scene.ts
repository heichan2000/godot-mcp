import { z } from "zod";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import { hasImportCache } from "../godot/cache.js";
import {
  assertInsideRoot,
  detectGodotPath,
  godotNotFoundError,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import {
  resolveOperationsScriptPath,
  runOperation,
  type RunOperationResult,
} from "../godot/runner.js";
import { propertiesSchema } from "../godot/values.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema, relativePathSchema, scenePathSchema } from "../schemas.js";

const DEFAULT_ROOT_NODE_TYPE = "Node2D";

export interface SceneToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  runOperation: typeof runOperation;
  /** Path to the bundled operations.gd dispatcher script. */
  operationsScriptPath: string;
  /** Checks whether project_path already has a built Godot import cache. */
  hasImportCache: typeof hasImportCache;
}

const defaultDeps: SceneToolsDeps = {
  loadConfig,
  detectGodotPath,
  runOperation,
  operationsScriptPath: resolveOperationsScriptPath(),
  hasImportCache,
};

/**
 * Guided error for an asset-dependent op (currently just `load_sprite`)
 * called against a project with no built import cache. Headless Godot
 * cannot `load()` an unimported asset - see `hasImportCache` in
 * `../godot/cache.js` for the empirically-verified marker this checks -
 * and this op never imports implicitly, so callers always see this error
 * instead of a slow, confusing Godot failure.
 */
function coldImportCacheError(projectPath: string) {
  return createErrorResponse({
    message:
      `Project at "${projectPath}" has no built Godot import cache yet ` +
      "(.godot/imported/ is missing or empty). Headless Godot cannot load a texture or other " +
      "importable asset until the project's assets have been imported at least once.",
    possibleSolutions: [
      "Run import_project with this project_path first to build the cache, then retry.",
      "If you just added or changed asset files, re-run import_project to refresh the cache.",
    ],
  });
}

/**
 * Builds guided `possibleSolutions` for an `operation-error` result by
 * matching the dispatcher's error text against the known failure shapes
 * each op in this file can produce. Falls back to a generic hint for
 * anything unrecognized (e.g. a future op's errors).
 */
function operationErrorSolutions(error: string): string[] {
  // Checked before the generic "already exists" branch below, which would
  // otherwise match this message too (it also contains "already exists")
  // but with create_scene-specific wording that doesn't mention new_path.
  if (/refuses to overwrite an existing scene at new_path/i.test(error)) {
    return [
      "Choose a different new_path that does not already exist.",
      "Omit new_path to re-save scene_path itself in place instead.",
    ];
  }
  if (/already exists/i.test(error)) {
    return [
      "Choose a different scene_path that does not already exist.",
      "To overwrite an existing scene, use a dedicated save/overwrite tool once available - create_scene intentionally refuses to overwrite.",
    ];
  }
  if (/scene does not exist at/i.test(error)) {
    return [
      "Check that scene_path points at an existing .tscn file relative to project_path.",
      "Use create_scene first if the scene does not exist yet.",
    ];
  }
  if (/is not an instantiable node class/i.test(error)) {
    return [
      "node_type/root_node_type must be a built-in Godot class name that exists, extends Node " +
        "(or is Node itself), and can be instantiated directly - not an abstract/editor-only " +
        "class (e.g. EditorPlugin), a script class name, or a res:// path.",
      "Check the exact, case-sensitive class name against the Godot class reference for this Godot version.",
    ];
  }
  if (/parent_node_path not found/i.test(error)) {
    return [
      "Check the exact node path (e.g. by inspecting the .tscn file, or with a scene-tree tool once available).",
      "Omit parent_node_path to attach the new node under the scene root instead.",
    ];
  }
  if (/property does not exist on/i.test(error)) {
    return [
      "Check the property name against the Godot class reference for node_type - it is case-sensitive.",
      'Property values must be a JSON primitive or a var_to_str text form, e.g. "Vector2(100, 50)".',
    ];
  }
  if (/node_path not found in scene/i.test(error)) {
    return [
      "Check the exact node path (e.g. by inspecting the .tscn file).",
      "Omit node_path to target the scene root itself.",
    ];
  }
  if (/is not a sprite2d or sprite3d/i.test(error)) {
    return [
      "node_path must point at a Sprite2D or Sprite3D node - check the node's class in the scene.",
      "Use add_node to create a Sprite2D or Sprite3D node first if one does not exist yet.",
    ];
  }
  if (/texture does not exist at/i.test(error)) {
    return [
      "Check that texture_path points at an existing image file relative to project_path.",
      "If the file was just added, re-run import_project so it enters the import cache.",
    ];
  }
  if (/failed to load .* as a texture2d/i.test(error)) {
    return [
      "Confirm texture_path points at a supported image format (e.g. .png).",
      "Re-run import_project to rebuild the import cache, then retry.",
    ];
  }
  if (/contains no meshinstance3d nodes with an assigned mesh/i.test(error)) {
    return [
      "Add a MeshInstance3D node (via add_node) and assign a mesh via its mesh property before exporting.",
      "Check that scene_path points at the intended scene.",
    ];
  }
  if (/none of the requested mesh_item_names matched/i.test(error)) {
    return [
      "Check the exact, case-sensitive node names against the scene - the error lists the available item names.",
      "Omit mesh_item_names to export every eligible MeshInstance3D in the scene.",
    ];
  }
  if (/failed to save mesh library to/i.test(error)) {
    return [
      "Check that output_path's parent directory is writable.",
      "Confirm output_path ends in a resource extension Godot recognizes (e.g. .res or .tres).",
    ];
  }
  return ["Check that scene_path and the other parameters are valid for this project."];
}

/**
 * Converts a `RunOperationResult` into an MCP tool result. `success` is the
 * only non-error branch; every other kind maps to a guided
 * `createErrorResponse`, tailored to what actually went wrong (an op-level
 * failure reported by the dispatcher vs. a version mismatch vs. Godot
 * failing to even respond). `successLabel` prefixes the human-readable text
 * for a successful call (e.g. "Created scene", "Added node").
 */
function operationResultToToolResult(result: RunOperationResult, successLabel: string) {
  switch (result.kind) {
    case "success":
      return {
        content: [
          {
            type: "text" as const,
            text: `${successLabel}: ${JSON.stringify(result.result)}`,
          },
        ],
        structuredContent: result.result,
      };
    case "operation-error":
      return createErrorResponse({
        message: result.error,
        possibleSolutions: operationErrorSolutions(result.error),
      });
    case "version-mismatch":
      return createErrorResponse({
        message:
          `Dispatcher version mismatch: the runner expects operations.gd version ` +
          `${result.expectedVersion}, but the dispatcher reported version ${result.actualVersion}.`,
        possibleSolutions: [
          "Reinstall or rebuild the package so the bundled operations.gd matches this server version (npm install / npm run build).",
          "If you customized operations.gd, update its VERSION constant to match the runner's expected version.",
        ],
      });
    case "protocol-error":
      return createErrorResponse({
        message: result.message,
        possibleSolutions: [
          "Run with DEBUG=1 and inspect stderr for the underlying Godot error.",
          "Confirm GODOT_PATH points at a working Godot 4.x headless-capable executable.",
        ],
      });
    case "spawn-error":
      return createErrorResponse({
        message: `Failed to launch Godot: ${result.message}`,
        possibleSolutions: [
          "Confirm GODOT_PATH points at a valid, executable Godot 4.x binary.",
          "Try running the executable manually from a terminal to confirm it works.",
        ],
      });
    case "timeout":
      return createErrorResponse({
        message:
          `Godot did not respond within ${result.timeoutMs}ms and was killed. This usually ` +
          "means the process hung (e.g. a stuck asset import, a blocking dialog, or a deadlock " +
          "in headless mode) rather than finishing.",
        possibleSolutions: [
          "Try running the same Godot command manually from a terminal to see whether it hangs or prompts for input.",
          "Check for a stuck import (e.g. delete the .godot/imported cache and retry) or other one-time startup cost that may need a longer timeout.",
          "If this project is unusually large or slow to open, a future call may need a larger timeoutMs than the default.",
        ],
      });
  }
}

/**
 * Builds the `tools/scene.ts` descriptor group. Godot resolution and the
 * dispatcher invocation both happen lazily inside the handler (never at
 * registration time), matching `tools/editor.ts`.
 */
const createSceneInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema,
  root_node_type: z
    .string()
    .min(1)
    .optional()
    .describe(`Godot node class for the scene root. Defaults to ${DEFAULT_ROOT_NODE_TYPE}.`),
};

const addNodeInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema.describe(
    "Path to an existing .tscn scene file, relative to project_path.",
  ),
  node_type: z
    .string()
    .min(1)
    .describe(
      "Godot node class for the new node, e.g. Sprite2D. Must exist, extend Node (or be Node " +
        "itself), and be directly instantiable - checked against Godot's own ClassDB, so no " +
        "curated allow-list. Rejects script class names, res:// paths, and abstract/editor-only " +
        "classes.",
    ),
  node_name: z.string().min(1).describe("Name for the new node within the scene."),
  parent_node_path: z
    .string()
    .optional()
    .describe(
      "Path (relative to the scene root) of the node to attach the new node under. Must " +
        "already exist in the scene. Defaults to the scene root itself when omitted.",
    ),
  properties: propertiesSchema
    .optional()
    .describe(
      "Property name -> value to set on the new node via set(). String values are parsed with " +
        'Godot\'s str_to_var, so bare literals like "42", "true", or "[1, 2]" decode to an int, ' +
        "bool, or Array rather than a literal string; non-primitive types use this same " +
        'var_to_str text form, e.g. {"position": "Vector2(100, 50)"}. To force a literal ' +
        'string, quote it var_to_str-style (.tscn\'s own string syntax) - "\\"42\\"" decodes to ' +
        'the string "42". Plain text that is not a recognized Godot literal (e.g. "hello") ' +
        "stays a string as-is. A property that does not exist on node_type is a structured " +
        "error.",
    ),
};

const loadSpriteInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema.describe(
    "Path to an existing .tscn scene file, relative to project_path.",
  ),
  node_path: z
    .string()
    .optional()
    .describe(
      "Path (relative to the scene root) of the Sprite2D or Sprite3D node to assign the " +
        "texture to. Must already exist in the scene and be a Sprite2D or Sprite3D. Defaults to " +
        "the scene root itself when omitted.",
    ),
  texture_path: relativePathSchema.describe(
    "Path to an existing image file (e.g. .png), relative to project_path. Must already be " +
      "covered by the project's import cache - run import_project first if it is not.",
  ),
};

const saveSceneInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema.describe(
    "Path to an existing .tscn scene file, relative to project_path.",
  ),
  new_path: scenePathSchema
    .optional()
    .describe(
      "Optional path to save the scene as a new file ('save as'), relative to project_path. " +
        "Must not already exist - save_scene refuses to overwrite an existing file at new_path. " +
        "When omitted, scene_path is re-saved in place instead.",
    ),
};

const exportMeshLibraryInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema.describe(
    "Path to an existing .tscn scene file, relative to project_path.",
  ),
  output_path: relativePathSchema.describe(
    "Path to write the MeshLibrary resource to, relative to project_path. Conventionally ends " +
      "in .res (a binary resource) or .tres (a human-readable text resource) - either is " +
      "accepted. Parent directories are created as needed. Always overwritten if it already " +
      "exists: unlike a hand-authored scene, this is a derived build artifact meant to be " +
      "regenerated on demand.",
  ),
  mesh_item_names: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional allow-list of node names to include as MeshLibrary items. Only MeshInstance3D " +
        "nodes whose own node name is in this list are exported; every eligible MeshInstance3D " +
        "in the scene is exported when omitted (or left empty). A name that matches nothing " +
        "among the scene's mesh nodes is a structured error naming the available item names.",
    ),
};

export function createSceneTools(deps: SceneToolsDeps = defaultDeps): ToolDescriptor[] {
  const createScene: ToolDescriptor<typeof createSceneInputSchema> = {
    name: "create_scene",
    description:
      "Creates a new .tscn scene file containing a single root node (default Node2D). " +
      "scene_path is relative to project_path and must not exist yet.",
    inputSchema: createSceneInputSchema,
    handler: async ({ project_path, scene_path, root_node_type }) => {
      try {
        assertInsideRoot(project_path, scene_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] create_scene: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "create_scene",
        params: {
          scene_path,
          root_node_type: root_node_type ?? DEFAULT_ROOT_NODE_TYPE,
        },
      });

      return operationResultToToolResult(result, "Created scene");
    },
  };

  const addNode: ToolDescriptor<typeof addNodeInputSchema> = {
    name: "add_node",
    description:
      "Adds a node to an existing scene and saves the scene in place. node_type is gated by " +
      "Godot's own ClassDB: it must be a known, Node-derived (or Node itself), instantiable " +
      "class - built-in classes only, never a script class name or a res:// path. " +
      "parent_node_path is relative to the scene root and selects where the new node attaches " +
      "(the scene root itself when omitted); it must already exist in the scene. properties " +
      "sets values on the new node via set(): every string value is parsed with Godot's " +
      'str_to_var, so a bare literal like "42", "true", or "[1, 2]" decodes to an int, bool, or ' +
      "Array rather than a literal string; non-primitive types use this same var_to_str text " +
      'form, e.g. {"position": "Vector2(100, 50)", "modulate": "Color(1, 0, 0, 1)", "visible": ' +
      "true} - the same syntax used inside .tscn files. To force a literal string, quote it " +
      'var_to_str-style - "\\"42\\"" decodes to the string "42". A property that does not ' +
      "exist on node_type is a structured error, not a silent no-op.",
    inputSchema: addNodeInputSchema,
    handler: async ({
      project_path,
      scene_path,
      node_type,
      node_name,
      parent_node_path,
      properties,
    }) => {
      try {
        assertInsideRoot(project_path, scene_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] add_node: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "add_node",
        params: {
          scene_path,
          node_type,
          node_name,
          parent_node_path: parent_node_path ?? "",
          properties: properties ?? {},
        },
      });

      return operationResultToToolResult(result, "Added node");
    },
  };

  const loadSprite: ToolDescriptor<typeof loadSpriteInputSchema> = {
    name: "load_sprite",
    description:
      "Assigns a texture to a Sprite2D or Sprite3D node in an existing scene and saves the " +
      "scene in place. node_path is relative to the scene root (the root itself when omitted) " +
      "and must already resolve to a Sprite2D or Sprite3D node - any other class is a structured " +
      "error. Requires project_path's Godot import cache to already be built: this is the first " +
      "asset-dependent tool, and headless Godot cannot load a texture until its assets have been " +
      "imported at least once - if the cache is missing, this returns a guided error naming " +
      "import_project instead of importing implicitly.",
    inputSchema: loadSpriteInputSchema,
    handler: async ({ project_path, scene_path, node_path, texture_path }) => {
      try {
        assertInsideRoot(project_path, scene_path);
        assertInsideRoot(project_path, texture_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      if (!deps.hasImportCache(project_path)) {
        return coldImportCacheError(project_path);
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] load_sprite: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "load_sprite",
        params: {
          scene_path,
          node_path: node_path ?? "",
          texture_path,
        },
      });

      return operationResultToToolResult(result, "Loaded sprite texture");
    },
  };

  const saveScene: ToolDescriptor<typeof saveSceneInputSchema> = {
    name: "save_scene",
    description:
      "Saves an existing scene. Without new_path, re-saves the scene at scene_path in place - " +
      "this server is stateless (every op loads, mutates, and saves within a single call), so " +
      "this simply reloads and rewrites the same file, normalizing its contents rather than " +
      "reflecting any accumulated editor state. With new_path, performs a 'save as': the loaded " +
      "scene is written to new_path and the original file at scene_path is left untouched. " +
      "save_scene refuses to overwrite an existing file at new_path (mirroring create_scene's " +
      "guard against clobbering an existing scene) - to intentionally replace scene_path itself, " +
      "just omit new_path and re-save in place.",
    inputSchema: saveSceneInputSchema,
    handler: async ({ project_path, scene_path, new_path }) => {
      try {
        assertInsideRoot(project_path, scene_path);
        if (new_path !== undefined) {
          assertInsideRoot(project_path, new_path);
        }
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] save_scene: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "save_scene",
        params: {
          scene_path,
          new_path: new_path ?? "",
        },
      });

      return operationResultToToolResult(result, "Saved scene");
    },
  };

  const exportMeshLibrary: ToolDescriptor<typeof exportMeshLibraryInputSchema> = {
    name: "export_mesh_library",
    description:
      "Exports every MeshInstance3D node in an existing scene (walked recursively, including " +
      "the scene root) that has a mesh assigned as one item in a newly built MeshLibrary " +
      "resource, saved to output_path. Item name = node name, item mesh = the node's assigned " +
      "mesh; a MeshInstance3D with no mesh assigned is skipped. Set mesh_item_names to export " +
      "only a subset by node name - omit it to export every eligible MeshInstance3D. A scene " +
      "with no eligible mesh nodes, or a mesh_item_names filter that matches none of them, is a " +
      "structured error.",
    inputSchema: exportMeshLibraryInputSchema,
    handler: async ({ project_path, scene_path, output_path, mesh_item_names }) => {
      try {
        assertInsideRoot(project_path, scene_path);
        assertInsideRoot(project_path, output_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] export_mesh_library: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const params: Record<string, unknown> = { scene_path, output_path };
      if (mesh_item_names !== undefined) {
        params.mesh_item_names = mesh_item_names;
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "export_mesh_library",
        params,
      });

      return operationResultToToolResult(result, "Exported mesh library");
    },
  };

  // registerAll pairs each descriptor's handler with its own inputSchema at
  // registration time (the SDK only ever invokes a handler with args already
  // validated against that same schema), so widening the concrete
  // ToolDescriptor<typeof createSceneInputSchema | typeof addNodeInputSchema | typeof loadSpriteInputSchema
  //   | typeof saveSceneInputSchema | typeof exportMeshLibraryInputSchema>
  // into the heterogeneous ToolDescriptor[] return type is safe in practice
  // even though the handler parameter types are contravariant and TS can't
  // verify that pairing across a shared array element type.
  return [
    createScene as unknown as ToolDescriptor,
    addNode as unknown as ToolDescriptor,
    loadSprite as unknown as ToolDescriptor,
    saveScene as unknown as ToolDescriptor,
    exportMeshLibrary as unknown as ToolDescriptor,
  ];
}

export const sceneTools: ToolDescriptor[] = createSceneTools();
