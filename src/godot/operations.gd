extends SceneTree
##
## godot-mcp bundled operations dispatcher.
##
## Invoked headless by src/godot/runner.ts as:
##   godot --headless --path <project> --script operations.gd -- <operation> <json-params>
##
## `OS.get_cmdline_user_args()` returns exactly the two arguments after the
## `--` separator: the operation name and a single JSON-encoded params
## string. Params travel as data (never interpolated into the command line),
## so there is no shell-injection surface.
##
## Contract: exactly one line is printed to stdout, prefixed with
## RESULT_MARKER, containing a JSON object:
##   { "ok": bool, "version": int, "operation": string, "result"?: {...}, "error"?: string }
## Everything else Godot prints (engine banner, warnings) is noise the
## runner ignores by locating the marker line. Process exit code is 0 on
## success (ok == true), 1 otherwise.
##
## VERSION must be bumped whenever this contract (argv shape or result
## shape) changes. The runner performs a version handshake by comparing its
## own expected version against the `version` field on every result and
## refuses to trust a mismatched dispatcher.

const VERSION := 1
const RESULT_MARKER := "GODOT_MCP_RESULT:"

func _init() -> void:
	quit(run())

func run() -> int:
	var user_args := OS.get_cmdline_user_args()
	if user_args.size() != 2:
		emit_result({
			"ok": false,
			"version": VERSION,
			"operation": user_args[0] if user_args.size() > 0 else "",
			"error": "Expected exactly 2 arguments (<operation> <json-params>), got %d." % user_args.size(),
		})
		return 1

	var operation: String = user_args[0]
	var params: Variant = parse_params(user_args[1])
	if params == null:
		emit_result({
			"ok": false,
			"version": VERSION,
			"operation": operation,
			"error": "Failed to parse params as a JSON object: %s" % user_args[1],
		})
		return 1

	var outcome := dispatch(operation, params)
	var ok: bool = outcome.get("ok", false)
	emit_result({
		"ok": ok,
		"version": VERSION,
		"operation": operation,
		"result": outcome.get("result", {}),
		"error": outcome.get("error", ""),
	})
	return 0 if ok else 1

## Returns a Dictionary on valid JSON-object input, null otherwise (parse
## failure or a non-object JSON value like a bare number or array).
func parse_params(raw: String) -> Variant:
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		return null
	return parsed

func dispatch(operation: String, params: Dictionary) -> Dictionary:
	match operation:
		"create_scene":
			return op_create_scene(params)
		"add_node":
			return op_add_node(params)
		"load_sprite":
			return op_load_sprite(params)
		"save_scene":
			return op_save_scene(params)
		"export_mesh_library":
			return op_export_mesh_library(params)
		"get_scene_tree":
			return op_get_scene_tree(params)
		"read_node_properties":
			return op_read_node_properties(params)
		"get_uid":
			return op_get_uid(params)
		"update_project_uids":
			return op_update_project_uids(params)
		"list_resources":
			return op_list_resources(params)
		_:
			return { "ok": false, "error": "Unknown operation: %s" % operation }

## create_scene(scene_path: String, root_node_type: String = "Node2D")
## Creates a new scene containing a single root node and saves it to
## scene_path (project-relative, res:// implied). Creates parent
## directories as needed.
func op_create_scene(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: the TS layer already confines scene_path inside
	# project_path via assertInsideRoot before this script ever runs, but we
	# re-check here since operations.gd can, in principle, be invoked
	# directly.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	var root_node_type: String = params.get("root_node_type", "Node2D")
	if typeof(root_node_type) != TYPE_STRING or root_node_type.is_empty():
		root_node_type = "Node2D"

	if not is_instantiable_node_class(root_node_type):
		return { "ok": false, "error": "root_node_type is not an instantiable Node class: %s" % root_node_type }

	var res_path := to_res_path(scene_path)
	if FileAccess.file_exists(res_path):
		return { "ok": false, "error": "Scene already exists at %s. create_scene refuses to overwrite an existing scene." % res_path }

	var dir_outcome := ensure_parent_dir_exists(res_path)
	if not dir_outcome["ok"]:
		return dir_outcome

	var root_node: Node = ClassDB.instantiate(root_node_type)
	root_node.name = res_path.get_file().get_basename()

	var packed_outcome := pack_and_save(root_node, res_path)
	if not packed_outcome["ok"]:
		return packed_outcome

	return { "ok": true, "result": { "scene_path": res_path, "root_node_type": root_node_type } }

## add_node(scene_path: String, node_type: String, node_name: String, parent_node_path: String = "", properties: Dictionary = {})
## Loads the existing scene at scene_path, instantiates a new node_type node
## (must pass is_instantiable_node_class), names it node_name, attaches it
## under parent_node_path (the scene root when omitted or empty - error if
## the path doesn't resolve to an existing node), applies each entry of
## `properties` via the shared value codec (see decode_property_value - a
## property that doesn't exist on the node errors rather than silently
## no-opping), sets its owner to the scene root so it persists, then packs
## and saves the scene back in place.
func op_add_node(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	if not params.has("node_type") or typeof(params["node_type"]) != TYPE_STRING or params["node_type"].is_empty():
		return { "ok": false, "error": "Missing or invalid required param: node_type" }
	var node_type: String = params["node_type"]
	if not is_instantiable_node_class(node_type):
		return { "ok": false, "error": "node_type is not an instantiable Node class: %s" % node_type }

	if not params.has("node_name") or typeof(params["node_name"]) != TYPE_STRING or params["node_name"].is_empty():
		return { "ok": false, "error": "Missing or invalid required param: node_name" }
	var node_name: String = params["node_name"]

	var parent_node_path: String = params.get("parent_node_path", "")
	if typeof(parent_node_path) != TYPE_STRING:
		parent_node_path = ""

	var properties: Dictionary = {}
	if params.has("properties"):
		if typeof(params["properties"]) != TYPE_DICTIONARY:
			return { "ok": false, "error": "properties must be an object mapping property name to value." }
		properties = params["properties"]

	var res_path := to_res_path(scene_path)
	if not FileAccess.file_exists(res_path):
		return { "ok": false, "error": "Scene does not exist at %s." % res_path }

	var load_outcome := load_scene_or_error(res_path)
	if not load_outcome["ok"]:
		return load_outcome
	var root: Node = load_outcome["root"]

	var parent: Node = root
	if not parent_node_path.is_empty():
		parent = root.get_node_or_null(NodePath(parent_node_path))
		if parent == null:
			root.free()
			return { "ok": false, "error": "parent_node_path not found in scene: %s" % parent_node_path }

	var new_node: Node = ClassDB.instantiate(node_type)
	new_node.name = node_name
	parent.add_child(new_node)
	new_node.owner = root

	for key in properties.keys():
		if typeof(key) != TYPE_STRING:
			root.free()
			return { "ok": false, "error": "Property names must be strings." }
		var property_name: String = key
		if not has_property(new_node, property_name):
			root.free()
			return { "ok": false, "error": "Property does not exist on %s: %s" % [node_type, property_name] }
		var decoded_value: Variant = decode_property_value(properties[key])
		new_node.set(property_name, decoded_value)

	var new_node_path := str(root.get_path_to(new_node))

	var packed_outcome := pack_and_save(root, res_path)
	if not packed_outcome["ok"]:
		return packed_outcome

	return {
		"ok": true,
		"result": {
			"scene_path": res_path,
			"node_type": node_type,
			"node_name": node_name,
			"node_path": new_node_path,
		},
	}

## load_sprite(scene_path: String, node_path: String = "", texture_path: String)
## Loads the existing scene at scene_path, resolves node_path to a node (the
## scene root itself when node_path is empty or omitted), verifies it is a
## Sprite2D or Sprite3D (both expose a Texture2D-typed `texture` property),
## load()s texture_path as a Texture2D, assigns it to that node's `texture`
## property, then packs and saves the scene back in place.
##
## Callers must confirm the project's import cache is already built (see
## hasImportCache in src/godot/cache.ts) BEFORE invoking this op - headless
## Godot cannot load() an unimported asset, and this op never attempts to
## import anything itself, matching godot-prd.md §3 "Asset imports": asset-
## dependent ops detect a cold cache and guide the caller to import_project
## rather than importing implicitly.
func op_load_sprite(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	if not params.has("texture_path") or typeof(params["texture_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: texture_path" }
	var texture_path: String = params["texture_path"]
	if texture_path.is_empty():
		return { "ok": false, "error": "texture_path must not be empty." }
	if texture_path.contains(".."):
		return { "ok": false, "error": "texture_path must not contain '..' segments: %s" % texture_path }

	var node_path: String = params.get("node_path", "")
	if typeof(node_path) != TYPE_STRING:
		node_path = ""

	var res_scene_path := to_res_path(scene_path)
	if not FileAccess.file_exists(res_scene_path):
		return { "ok": false, "error": "Scene does not exist at %s." % res_scene_path }

	var load_outcome := load_scene_or_error(res_scene_path)
	if not load_outcome["ok"]:
		return load_outcome
	var root: Node = load_outcome["root"]

	var target: Node = root
	if not node_path.is_empty():
		target = root.get_node_or_null(NodePath(node_path))
		if target == null:
			root.free()
			return { "ok": false, "error": "node_path not found in scene: %s" % node_path }

	if not (target is Sprite2D or target is Sprite3D):
		var described_path := node_path if not node_path.is_empty() else "<scene root>"
		var actual_class := target.get_class()
		root.free()
		return { "ok": false, "error": "Node at %s is a %s, not a Sprite2D or Sprite3D." % [described_path, actual_class] }

	var res_texture_path := to_res_path(texture_path)
	if not FileAccess.file_exists(res_texture_path):
		root.free()
		return { "ok": false, "error": "Texture does not exist at %s." % res_texture_path }

	var texture: Resource = load(res_texture_path)
	if texture == null or not (texture is Texture2D):
		root.free()
		return { "ok": false, "error": "Failed to load %s as a Texture2D. Confirm the file is a supported image format and that the project's import cache is built (see import_project)." % res_texture_path }

	target.set("texture", texture)

	var packed_outcome := pack_and_save(root, res_scene_path)
	if not packed_outcome["ok"]:
		return packed_outcome

	return {
		"ok": true,
		"result": {
			"scene_path": res_scene_path,
			"node_path": node_path,
			"texture_path": res_texture_path,
		},
	}

## save_scene(scene_path: String, new_path: String = "")
## Loads the existing scene at scene_path and re-saves it. Without new_path,
## this re-saves the scene in place at scene_path: this server is stateless
## (every op loads -> mutates -> saves within a single invocation, never
## keeping an open editor session), so this simply reloads and rewrites the
## same file, normalizing its on-disk contents rather than reflecting any
## accumulated state. With new_path, this is "save as": the loaded scene is
## written to new_path (parent directories created as needed) and the
## original file at scene_path is left untouched. Refuses to overwrite an
## existing file at new_path, mirroring op_create_scene's guard against
## clobbering an existing scene - to replace scene_path itself, omit
## new_path and let this re-save in place instead.
func op_save_scene(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	var new_path: String = params.get("new_path", "")
	if typeof(new_path) != TYPE_STRING:
		new_path = ""
	if not new_path.is_empty() and new_path.contains(".."):
		return { "ok": false, "error": "new_path must not contain '..' segments: %s" % new_path }

	var res_path := to_res_path(scene_path)
	if not FileAccess.file_exists(res_path):
		return { "ok": false, "error": "Scene does not exist at %s." % res_path }

	var load_outcome := load_scene_or_error(res_path)
	if not load_outcome["ok"]:
		return load_outcome
	var root: Node = load_outcome["root"]

	var target_res_path := res_path
	if not new_path.is_empty():
		target_res_path = to_res_path(new_path)
		if FileAccess.file_exists(target_res_path):
			root.free()
			return { "ok": false, "error": "Scene already exists at %s. save_scene refuses to overwrite an existing scene at new_path." % target_res_path }
		var dir_outcome := ensure_parent_dir_exists(target_res_path)
		if not dir_outcome["ok"]:
			root.free()
			return dir_outcome

	var packed_outcome := pack_and_save(root, target_res_path)
	if not packed_outcome["ok"]:
		return packed_outcome

	return {
		"ok": true,
		"result": {
			"scene_path": res_path,
			"new_path": target_res_path if not new_path.is_empty() else "",
			"saved_path": target_res_path,
		},
	}

## export_mesh_library(scene_path: String, output_path: String, mesh_item_names: Array = [])
## Loads the existing scene at scene_path, recursively walks its node tree
## (root included) for every MeshInstance3D node that has a mesh assigned,
## and builds a new MeshLibrary resource with one item per match (item name
## = node name, item mesh = MeshInstance3D.mesh). A MeshInstance3D with no
## mesh assigned is skipped - an item with a null mesh is useless. When
## mesh_item_names is a non-empty array, only mesh instances whose node name
## is in that list are included (a name that matches nothing among the
## scene's mesh nodes is a structured error naming the available item
## names); an empty or omitted mesh_item_names exports every eligible
## MeshInstance3D. Saves the resulting MeshLibrary to output_path (parent
## directories created as needed) via ResourceSaver - always overwrites an
## existing file at output_path, since a MeshLibrary export is a derived
## build artifact meant to be regenerated, unlike a hand-authored scene
## (contrast op_create_scene/op_save_scene's overwrite refusal).
func op_export_mesh_library(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	if not params.has("output_path") or typeof(params["output_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: output_path" }
	var output_path: String = params["output_path"]
	if output_path.is_empty():
		return { "ok": false, "error": "output_path must not be empty." }
	if output_path.contains(".."):
		return { "ok": false, "error": "output_path must not contain '..' segments: %s" % output_path }

	var mesh_item_names: Array = []
	if params.has("mesh_item_names"):
		if typeof(params["mesh_item_names"]) != TYPE_ARRAY:
			return { "ok": false, "error": "mesh_item_names must be an array of strings." }
		for entry in params["mesh_item_names"]:
			if typeof(entry) != TYPE_STRING:
				return { "ok": false, "error": "mesh_item_names must be an array of strings." }
		mesh_item_names = params["mesh_item_names"]

	var res_scene_path := to_res_path(scene_path)
	if not FileAccess.file_exists(res_scene_path):
		return { "ok": false, "error": "Scene does not exist at %s." % res_scene_path }

	var load_outcome := load_scene_or_error(res_scene_path)
	if not load_outcome["ok"]:
		return load_outcome
	var root: Node = load_outcome["root"]

	var mesh_instances: Array = []
	collect_mesh_instances(root, mesh_instances)

	if mesh_instances.is_empty():
		root.free()
		return { "ok": false, "error": "Scene at %s contains no MeshInstance3D nodes with an assigned mesh." % res_scene_path }

	var selected: Array = mesh_instances
	if not mesh_item_names.is_empty():
		var available_names: Array = []
		for mi in mesh_instances:
			available_names.append((mi as MeshInstance3D).name as String)

		selected = []
		for mi in mesh_instances:
			if mesh_item_names.has((mi as MeshInstance3D).name as String):
				selected.append(mi)

		if selected.is_empty():
			root.free()
			return {
				"ok": false,
				"error": "None of the requested mesh_item_names matched a mesh item in the scene: %s. Available item names: %s" % [JSON.stringify(mesh_item_names), JSON.stringify(available_names)],
			}

	var library := MeshLibrary.new()
	var item_names: Array = []
	var item_id := 0
	for mi_variant in selected:
		var mi: MeshInstance3D = mi_variant
		library.create_item(item_id)
		library.set_item_name(item_id, mi.name)
		library.set_item_mesh(item_id, mi.mesh)
		item_names.append(mi.name as String)
		item_id += 1

	root.free()

	var res_output_path := to_res_path(output_path)
	var dir_outcome := ensure_parent_dir_exists(res_output_path)
	if not dir_outcome["ok"]:
		return dir_outcome

	var save_err := ResourceSaver.save(library, res_output_path)
	if save_err != OK:
		return { "ok": false, "error": "Failed to save mesh library to %s: error %d" % [res_output_path, save_err] }

	return {
		"ok": true,
		"result": {
			"scene_path": res_scene_path,
			"output_path": res_output_path,
			"item_names": item_names,
		},
	}

## get_scene_tree(scene_path: String)
## Loads the existing scene at scene_path (read-only - nothing is ever saved
## back) and walks its live instantiated node tree (root included), returning
## a nested { name, type, path, children[] } structure. `type` is the node's
## actual Godot class (Node.get_class()) - the same ClassDB-recognized name
## is_instantiable_node_class checks node_type/root_node_type against.
## `path` is root.get_path_to(node) stringified: "." for the scene root
## itself, and a root-relative NodePath string (e.g. "Sprite", "Body/Hero")
## for every other node - the exact same convention add_node's returned
## node_path, and parent_node_path/load_sprite's node_path already use, so a
## path returned here is directly usable as another op's node_path input
## (see op_read_node_properties below).
func op_get_scene_tree(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	var res_path := to_res_path(scene_path)
	if not FileAccess.file_exists(res_path):
		return { "ok": false, "error": "Scene does not exist at %s." % res_path }

	var load_outcome := load_scene_or_error(res_path)
	if not load_outcome["ok"]:
		return load_outcome
	var root: Node = load_outcome["root"]

	var tree := build_scene_tree_node(root, root)
	root.free()

	return { "ok": true, "result": { "scene_path": res_path, "tree": tree } }

## read_node_properties(scene_path: String, node_path: String, properties: Array = [])
## Loads the existing scene at scene_path (read-only - nothing is ever saved
## back), resolves node_path (root-relative NodePath, "." for the scene root
## itself - see op_get_scene_tree) to a node, and returns { scene_path,
## node_path (canonicalized), node_type, properties }. A node_path that does
## not resolve to a node in the scene is a structured error listing every
## available node path (via the same tree walk op_get_scene_tree uses), so a
## caller can retry without guessing, or call get_scene_tree directly.
##
## Default (properties omitted): properties contains ONLY what is actually
## stored in the .tscn for this node - i.e. the node's non-default state,
## read via PackedScene.get_state() (SceneState.get_node_property_count/
## name/value) - never the live instantiated node's full ~40+-entry property
## list. This mirrors the on-disk scene file exactly rather than diffing
## live values against ClassDB defaults. SceneState's own get_node_path()
## uses a "./"-prefixed convention (e.g. "./Body/Hero") that differs from
## Node.get_path_to()'s convention this op resolves node_path with (no
## leading "./", e.g. "Body/Hero") - normalize_state_node_path bridges that.
##
## With an explicit, non-empty properties array: each named property is
## fetched from the LIVE instantiated node via Object.get() instead (so a
## property matching its class default, like an untouched position, is
## still returned) - a name that isn't a real property on the node is a
## structured error, mirroring add_node's has_property check.
##
## Every returned property value uses the shared codec's read direction
## (see encode_property_value): bool/int/float/String travel as native
## JSON, every other Godot type travels as its var_to_str text form - the
## exact inverse of decode_property_value, so a value add_node wrote as
## "Vector2(100, 50)" reads back here as that identical string.
func op_read_node_properties(params: Dictionary) -> Dictionary:
	if not params.has("scene_path") or typeof(params["scene_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: scene_path" }
	var scene_path: String = params["scene_path"]
	if scene_path.is_empty():
		return { "ok": false, "error": "scene_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if scene_path.contains(".."):
		return { "ok": false, "error": "scene_path must not contain '..' segments: %s" % scene_path }

	if not params.has("node_path") or typeof(params["node_path"]) != TYPE_STRING or (params["node_path"] as String).is_empty():
		return { "ok": false, "error": "Missing or invalid required param: node_path" }
	var node_path: String = params["node_path"]

	var properties_filter: Array = []
	var has_properties_filter := false
	if params.has("properties"):
		if typeof(params["properties"]) != TYPE_ARRAY:
			return { "ok": false, "error": "properties must be an array of property name strings." }
		for entry in params["properties"]:
			if typeof(entry) != TYPE_STRING or (entry as String).is_empty():
				return { "ok": false, "error": "properties must be an array of non-empty property name strings." }
		properties_filter = params["properties"]
		has_properties_filter = true

	var res_path := to_res_path(scene_path)
	if not FileAccess.file_exists(res_path):
		return { "ok": false, "error": "Scene does not exist at %s." % res_path }

	var load_outcome := load_scene_or_error(res_path)
	if not load_outcome["ok"]:
		return load_outcome
	var root: Node = load_outcome["root"]
	var packed: PackedScene = load_outcome["packed"]

	var target: Node = root.get_node_or_null(NodePath(node_path))
	if target == null:
		var available: Array = []
		collect_node_paths(root, root, available)
		root.free()
		return {
			"ok": false,
			"error": "node_path not found in scene: %s. Available node paths: %s" % [node_path, JSON.stringify(available)],
		}

	var canonical_path := str(root.get_path_to(target))
	var node_type := target.get_class()
	var result_properties: Dictionary = {}

	if has_properties_filter:
		for prop_name_variant in properties_filter:
			var prop_name: String = prop_name_variant
			if not has_property(target, prop_name):
				root.free()
				return { "ok": false, "error": "Property does not exist on %s: %s" % [node_type, prop_name] }
			result_properties[prop_name] = encode_property_value(target.get(prop_name))
	else:
		var state := packed.get_state()
		for i in range(state.get_node_count()):
			if normalize_state_node_path(str(state.get_node_path(i))) != canonical_path:
				continue
			for p in range(state.get_node_property_count(i)):
				var stored_prop_name: String = state.get_node_property_name(i, p)
				result_properties[stored_prop_name] = encode_property_value(state.get_node_property_value(i, p))
			break

	root.free()

	return {
		"ok": true,
		"result": {
			"scene_path": res_path,
			"node_path": canonical_path,
			"node_type": node_type,
			"properties": result_properties,
		},
	}

## get_uid(file_path: String)
## Returns the resource UID (formatted uid://... via ResourceUID.id_to_text)
## already assigned to the resource at file_path. Requires Godot >= 4.4 (the
## TS layer's minGodotVersion gate enforces this centrally at call time, not
## here) - ResourceLoader.get_resource_uid only returns a meaningful id once
## a resource has actually been assigned one. Scenes/resources authored (or
## last saved) before 4.4 may have no UID yet; op_update_project_uids
## backfills one by resaving.
func op_get_uid(params: Dictionary) -> Dictionary:
	if not params.has("file_path") or typeof(params["file_path"]) != TYPE_STRING:
		return { "ok": false, "error": "Missing or invalid required param: file_path" }
	var file_path: String = params["file_path"]
	if file_path.is_empty():
		return { "ok": false, "error": "file_path must not be empty." }
	# Defense in depth: see the matching comment in op_create_scene.
	if file_path.contains(".."):
		return { "ok": false, "error": "file_path must not contain '..' segments: %s" % file_path }

	var res_path := to_res_path(file_path)
	if not FileAccess.file_exists(res_path):
		return { "ok": false, "error": "File does not exist at %s." % res_path }

	var uid_id := ResourceLoader.get_resource_uid(res_path)
	if uid_id == ResourceUID.INVALID_ID:
		return { "ok": false, "error": "No UID is assigned to resource at %s yet. Run update_project_uids first." % res_path }

	return { "ok": true, "result": { "file_path": res_path, "uid": ResourceUID.id_to_text(uid_id) } }

## update_project_uids()
## Ensures every .tscn/.tres text resource under res:// (skipping
## dot-prefixed directories like .godot and .git) has a uid= embedded in its
## header line, generating and writing one in place for any that don't.
##
## IMPORTANT - empirically verified against Godot 4.6.3 (see task-9 report):
## ResourceSaver.save() run outside the actual editor process (i.e. from a
## plain --script/SceneTree run, which is how this whole dispatcher is
## invoked) does NOT embed a uid= into a resaved scene/resource, even when
## the project's import cache already exists - contrary to what the "the
## editor will add them automatically as you save" upgrade guidance implies.
## A ResourceLoader.load() -> ResourceSaver.save() round trip (this op's
## first implementation) was verified to leave the file just as UID-less as
## before. So this op does NOT use ResourceSaver at all: it reads each
## file's single-line header (e.g. `[gd_scene load_steps=2 format=3]`) as
## plain text, and - only when that line has no `uid=` attribute yet -
## generates a fresh id via ResourceUID.create_id() and inserts
## ` uid="uid://..."` immediately before the closing `]`, rewriting just
## that one line. This is a minimal, targeted text edit rather than a full
## resave, which also sidesteps ResourceSaver's independent tendency to
## renumber/restructure the rest of the file (e.g. load_steps, sub-resource
## IDs) - a smaller diff than an in-editor save would produce.
##
## A resource's uid= header is only picked up into Godot's project-wide UID
## registry (the same registry get_uid's ResourceLoader.get_resource_uid
## queries) by a project scan - which happens during `--import` (or opening
## the editor), never during a plain --script run like this one. So the TS
## handler (tools/uid.ts) runs `godot --headless --import` again right
## after this op succeeds, so a newly-embedded uid is immediately visible to
## the very next get_uid call rather than requiring the caller to separately
## remember to run import_project.
##
## Best-effort: a file that can't be read/parsed/written is recorded under
## "failed" rather than aborting the whole walk, so one bad file doesn't
## block progress on the rest of the project. "already_had_uid" lists files
## left untouched because they already had a uid= (no unnecessary diff).
func op_update_project_uids(params: Dictionary) -> Dictionary:
	var targets: Array = []
	collect_resave_targets("res://", targets)

	var touched: Array = []
	var already_had_uid: Array = []
	var failed: Array = []
	for path_variant in targets:
		var res_path: String = path_variant
		match ensure_uid_header(res_path):
			"touched":
				touched.append(res_path)
			"already_had_uid":
				already_had_uid.append(res_path)
			_:
				failed.append(res_path)

	return {
		"ok": true,
		"result": {
			"touched": touched,
			"touched_count": touched.size(),
			"already_had_uid": already_had_uid,
			"failed": failed,
		},
	}

## Reads res_path's header line (the first line of a .tscn/.tres, e.g.
## `[gd_scene load_steps=2 format=3]` or `[gd_resource type="..." format=3]`)
## and, if it does not already declare a `uid=` attribute, generates a new
## one via ResourceUID and rewrites just that line in place. Returns
## "already_had_uid" (no write happened), "touched" (uid was added and
## written), or "failed" (the file could not be read, did not look like a
## recognized .tscn/.tres header, or could not be written back).
func ensure_uid_header(res_path: String) -> String:
	var in_file := FileAccess.open(res_path, FileAccess.READ)
	if in_file == null:
		return "failed"
	var content := in_file.get_as_text()
	in_file.close()

	var newline_index := content.find("\n")
	var header_line := content if newline_index == -1 else content.substr(0, newline_index)
	var rest := "" if newline_index == -1 else content.substr(newline_index)

	if not (header_line.begins_with("[gd_scene") or header_line.begins_with("[gd_resource")):
		return "failed"
	if header_line.contains("uid="):
		return "already_had_uid"

	var closing_bracket_index := header_line.rfind("]")
	if closing_bracket_index == -1:
		return "failed"

	var new_uid := ResourceUID.create_id()
	var uid_text := ResourceUID.id_to_text(new_uid)
	var new_header := header_line.substr(0, closing_bracket_index) + " uid=\"%s\"]" % uid_text
	var new_content := new_header + rest

	var out_file := FileAccess.open(res_path, FileAccess.WRITE)
	if out_file == null:
		return "failed"
	out_file.store_string(new_content)
	out_file.close()

	# Registers the mapping in this same process's in-memory ResourceUID
	# registry too - harmless, and lets a later op in the same dispatcher
	# invocation (there is none today, but keeps this op internally
	# consistent) see it without needing a rescan.
	ResourceUID.add_id(new_uid, res_path)
	return "touched"

## Recursively collects every .tscn/.tres file under dir_path (res://
## paths) into out, skipping dot-prefixed directories (.godot, .git, ...) -
## those are never user resources and .godot in particular holds Godot's own
## generated cache, not project content to touch. Binary .res resources are
## deliberately not included: this op's header-patching approach only works
## on the single-line text header .tscn/.tres files have.
func collect_resave_targets(dir_path: String, out: Array) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while entry != "":
		if entry == "." or entry == "..":
			entry = dir.get_next()
			continue
		var full_path := dir_path.path_join(entry)
		if dir.current_is_dir():
			if not entry.begins_with("."):
				collect_resave_targets(full_path, out)
		else:
			var ext := entry.get_extension().to_lower()
			if ext == "tscn" or ext == "tres":
				out.append(full_path)
		entry = dir.get_next()
	dir.list_dir_end()

## list_resources(type: String = "")
## Recursively walks every file under res:// (skipping the internal .godot
## directory and any other dot-prefixed directory - .git, etc.), classifying
## each remaining file that Godot recognizes as a loadable resource, and
## returns { resources: [ { path, type, uid? }, ... ] }.
##
## `type` on each entry is the resource's actual Godot class - e.g.
## "CompressedTexture2D" for an imported .png (not the generic "Texture2D"),
## "PackedScene" for a .tscn, "GDScript" for a .gd script. There is no
## metadata-only "peek the type without loading" API on Godot's bound
## ResourceLoader - empirically confirmed against Godot 4.6.3 (see task-56
## report): ResourceLoader exposes exists/get_resource_uid/load/
## get_recognized_extensions_for_type/list_directory/get_dependencies/... but
## no get_resource_type, despite that name appearing in some editor-plugin
## (ResourceFormatLoader) docs. So this classifies by actually calling load()
## and reading the resulting instance's get_class() - the same information
## get_scene_tree already reports for live nodes, applied here to on-disk
## resources instead.
##
## `.import`/`.uid` sidecar files are skipped outright by extension (never
## real resources, just Godot-generated metadata) rather than relying on
## ResourceLoader.exists() to reject them, even though it empirically also
## does - being explicit here documents the intent instead of depending on
## incidental engine behavior.
##
## A path ResourceLoader.exists() confirms as recognized but that still
## fails to load() (e.g. any resource that fails to load for some reason) is
## skipped rather than erroring the whole listing - an unimported asset like
## a texture before import_project has built the project's import cache
## never even reaches this point, since ResourceLoader.exists() itself
## already returns false for it (empirically confirmed). godot-prd.md §3's
## "asset-dependent ops detect a cold cache and guide the caller to
## import_project" applies to ops that need one *specific* asset to load; a
## broad listing op has no single resource to name in a guided error -
## import_project (or noticing that an expected asset didn't show up) is the
## way to surface those instead.
##
## Optional `type` narrows results to resources whose class matches exactly
## OR is a subclass of it (ClassDB.is_parent_class), so type: "Texture2D"
## also matches a CompressedTexture2D. A `type` value that isn't a real
## ClassDB class name simply matches nothing (an empty resources list),
## rather than erroring - the same "unmatched filter, not a mistake" stance
## op_export_mesh_library's mesh_item_names filter does NOT take (that one
## errors on zero matches), because there the caller supplied specific known
## node names from the same scene; here type is an open-ended class name the
## caller may not know exists in this project ahead of time.
func op_list_resources(params: Dictionary) -> Dictionary:
	var type_filter: String = ""
	if params.has("type"):
		if typeof(params["type"]) != TYPE_STRING:
			return { "ok": false, "error": "type must be a string." }
		type_filter = params["type"]

	var resources: Array = []
	collect_resources("res://", type_filter, resources)
	resources.sort_custom(func(a, b): return (a["path"] as String) < (b["path"] as String))

	return { "ok": true, "result": { "resources": resources } }

## Recursively walks dir_path (a res:// path), appending a { path, type,
## uid? } Dictionary to out for every file that qualifies - see
## op_list_resources for the full classification/filtering contract this
## implements. Directories named "." / ".." are skipped as DirAccess
## iteration artifacts; any other dot-prefixed directory (.godot, .git, ...)
## is skipped entirely, matching collect_resave_targets's convention.
func collect_resources(dir_path: String, type_filter: String, out: Array) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while entry != "":
		if entry == "." or entry == "..":
			entry = dir.get_next()
			continue
		var full_path := dir_path.path_join(entry)
		if dir.current_is_dir():
			if not entry.begins_with("."):
				collect_resources(full_path, type_filter, out)
		else:
			maybe_collect_resource(full_path, type_filter, out)
		entry = dir.get_next()
	dir.list_dir_end()

## Classifies a single res:// file path and appends its { path, type, uid? }
## entry to out if it qualifies - see op_list_resources for the full
## contract. Silently does nothing for a path that isn't a resource
## ResourceLoader recognizes, a sidecar file, or one that fails to actually
## load.
func maybe_collect_resource(res_path: String, type_filter: String, out: Array) -> void:
	var ext := res_path.get_extension().to_lower()
	if ext == "import" or ext == "uid":
		return
	if not ResourceLoader.exists(res_path):
		return

	var resource: Resource = load(res_path)
	if resource == null:
		return
	var resource_type := resource.get_class()

	if not type_filter.is_empty():
		var matches := resource_type == type_filter \
				or (ClassDB.class_exists(type_filter) and ClassDB.is_parent_class(resource_type, type_filter))
		if not matches:
			return

	var entry: Dictionary = { "path": res_path, "type": resource_type }
	var uid_id := ResourceLoader.get_resource_uid(res_path)
	if uid_id != ResourceUID.INVALID_ID:
		entry["uid"] = ResourceUID.id_to_text(uid_id)

	out.append(entry)

## True only if type_name names a Node-derived (or exactly Node) class that
## can be instantiated directly: known to ClassDB, is_parent_class of "Node"
## (Godot's own semantics treat a class as its own parent for this check, so
## "Node" itself passes), and can_instantiate (excludes abstract/editor-only
## classes like EditorPlugin). Script-class names and res:// paths are never
## known to ClassDB, so both are rejected here for free - no curated list.
func is_instantiable_node_class(type_name: String) -> bool:
	return ClassDB.class_exists(type_name) \
			and ClassDB.is_parent_class(type_name, "Node") \
			and ClassDB.can_instantiate(type_name)

## True if obj has a property named property_name (own or inherited).
## Object.set() on an unknown property silently no-ops in Godot rather than
## erroring, so add_node checks this explicitly up front to turn that into a
## structured error instead of a silent no-op.
func has_property(obj: Object, property_name: String) -> bool:
	for prop in obj.get_property_list():
		if prop.get("name") == property_name:
			return true
	return false

## Decodes one `properties` entry from the shared value codec (see
## godot-prd.md §3 "Value encoding" and src/godot/values.ts): non-string
## JSON primitives (bool/int/float) pass through unchanged. A string value
## is first tried through str_to_var - Godot's own text form for every
## non-primitive type, e.g. "Vector2(100, 50)" - and used as the decoded
## value when that succeeds; only when str_to_var yields null (its signal
## for "not a recognized Godot literal", which also fires for an empty
## string) does the raw string get used as a literal string instead. This
## never calls load(): str_to_var can only build value types, never a
## Resource, and never runs code, so a property value can never be used to
## load an arbitrary resource or execute anything.
func decode_property_value(raw_value: Variant) -> Variant:
	if typeof(raw_value) != TYPE_STRING:
		return raw_value
	var decoded: Variant = str_to_var(raw_value)
	if decoded == null:
		return raw_value
	return decoded

## Encodes one live Godot property value for the shared value codec's READ
## direction (see godot-prd.md §3 "Value encoding" and decode_property_value
## above, its write-direction inverse): bool/int/float/String travel as
## native JSON, unchanged. Every other Variant type (Vector2, Color,
## NodePath, Resource, ...) travels as its var_to_str text form - the exact
## same syntax .tscn files and decode_property_value's str_to_var both use,
## so a value add_node wrote as "Vector2(100, 50)" round-trips back through
## this as that identical string.
func encode_property_value(value: Variant) -> Variant:
	match typeof(value):
		TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		_:
			return var_to_str(value)

## Recursively builds a { name, type, path, children[] } Dictionary for node
## and every descendant, for op_get_scene_tree. `path` is root-relative
## (root.get_path_to(node), stringified) - "." for the root itself, a plain
## NodePath string with no leading "./" for everything else (e.g. "Sprite",
## "Body/Hero") - matching the convention add_node's returned node_path and
## other ops' node_path/parent_node_path params already use.
func build_scene_tree_node(root: Node, node: Node) -> Dictionary:
	var children: Array = []
	for child in node.get_children():
		children.append(build_scene_tree_node(root, child))
	return {
		"name": (node.name as String),
		"type": node.get_class(),
		"path": str(root.get_path_to(node)),
		"children": children,
	}

## Flat variant of build_scene_tree_node: appends root.get_path_to(node)
## (stringified) for node and every descendant into out, in the same order
## build_scene_tree_node would visit them. Used to list "available node
## paths" in op_read_node_properties's unknown-node_path error.
func collect_node_paths(root: Node, node: Node, out: Array) -> void:
	out.append(str(root.get_path_to(node)))
	for child in node.get_children():
		collect_node_paths(root, child, out)

## PackedScene.SceneState's own get_node_path() uses a different string
## convention than Node.get_path_to(): "." for the scene root (same as
## get_path_to), but a leading "./" for every other node (e.g. "./Body/Hero")
## where get_path_to gives the leading-"./"-free "Body/Hero" - empirically
## confirmed against Godot 4.6.3 (see task-11 report). This strips that
## prefix so a SceneState path can be compared directly against a
## get_path_to-derived canonical path (see op_read_node_properties).
func normalize_state_node_path(state_path: String) -> String:
	if state_path.begins_with("./"):
		return state_path.substr(2)
	return state_path

## Loads res_path as a PackedScene and instantiates it, producing the exact
## same error text every one of its call sites previously duplicated inline.
## Returns { "ok": true, "root": Node, "packed": PackedScene } on success, or
## { "ok": false, "error": string } on either a load or an instantiate
## failure - the same shape every op_* function returns, so callers can
## return this dictionary directly on failure. Shared by op_add_node,
## op_load_sprite, op_save_scene, op_export_mesh_library, op_get_scene_tree,
## and op_read_node_properties, all of which load an existing scene before
## doing their own thing with its root node; the latter two also use the
## returned "packed" resource itself (op_read_node_properties's default mode
## reads its SceneState). Callers are expected to have already confirmed
## res_path exists (each op's own FileAccess.file_exists check stays at the
## call site, ahead of this call).
func load_scene_or_error(res_path: String) -> Dictionary:
	var loaded: Resource = load(res_path)
	if loaded == null or not (loaded is PackedScene):
		return { "ok": false, "error": "Failed to load scene at %s as a PackedScene." % res_path }
	var packed: PackedScene = loaded
	var root: Node = packed.instantiate()
	if root == null:
		return { "ok": false, "error": "Failed to instantiate scene at %s." % res_path }
	return { "ok": true, "root": root, "packed": packed }

## Packs root into a PackedScene and saves it to res_path, freeing root
## either way (pack() and free() must happen together regardless of
## outcome, matching the shape both op_create_scene and op_add_node need).
## Returns { "ok": true } on success, or { "ok": false, "error": string } on
## either a pack or a save failure - the same shape every op_* function
## returns, so callers can return this dictionary directly on failure.
func pack_and_save(root: Node, res_path: String) -> Dictionary:
	var packed := PackedScene.new()
	var pack_err := packed.pack(root)
	root.free()
	if pack_err != OK:
		return { "ok": false, "error": "Failed to pack scene: error %d" % pack_err }

	var save_err := ResourceSaver.save(packed, res_path)
	if save_err != OK:
		return { "ok": false, "error": "Failed to save scene to %s: error %d" % [res_path, save_err] }

	return { "ok": true }

## Creates res_path's parent directory (recursively) if it does not already
## exist. Returns { "ok": true } on success (including the no-op case where
## the directory already exists), or { "ok": false, "error": string } - the
## same shape every op_* function returns, so callers can return this
## dictionary directly on failure. Shared by op_create_scene, op_save_scene
## (its new_path branch), and op_export_mesh_library, all of which may need
## to write to a path whose parent directory doesn't exist yet.
func ensure_parent_dir_exists(res_path: String) -> Dictionary:
	var dir_path := res_path.get_base_dir()
	if not dir_path.is_empty() and not DirAccess.dir_exists_absolute(dir_path):
		var mkdir_err := DirAccess.make_dir_recursive_absolute(dir_path)
		if mkdir_err != OK:
			return { "ok": false, "error": "Failed to create parent directory %s: error %d" % [dir_path, mkdir_err] }
	return { "ok": true }

## Recursively collects every MeshInstance3D descendant of node (node itself
## included) that has a non-null mesh assigned, appending each into out.
## Node names are only guaranteed unique among siblings in Godot, not
## scene-wide, so more than one collected item can share a name -
## op_export_mesh_library treats that as legitimate (a mesh_item_names
## filter matches every node with that name) rather than an error.
func collect_mesh_instances(node: Node, out: Array) -> void:
	if node is MeshInstance3D and (node as MeshInstance3D).mesh != null:
		out.append(node)
	for child in node.get_children():
		collect_mesh_instances(child, out)

func to_res_path(relative_path: String) -> String:
	if relative_path.begins_with("res://"):
		return relative_path
	return "res://" + relative_path.replace("\\", "/").lstrip("/")

func emit_result(result: Dictionary) -> void:
	print(RESULT_MARKER + JSON.stringify(result))
