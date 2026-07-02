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

	var dir_path := res_path.get_base_dir()
	if not dir_path.is_empty() and not DirAccess.dir_exists_absolute(dir_path):
		var mkdir_err := DirAccess.make_dir_recursive_absolute(dir_path)
		if mkdir_err != OK:
			return { "ok": false, "error": "Failed to create parent directory %s: error %d" % [dir_path, mkdir_err] }

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

	var loaded: Resource = load(res_path)
	if loaded == null or not (loaded is PackedScene):
		return { "ok": false, "error": "Failed to load scene at %s as a PackedScene." % res_path }
	var root: Node = (loaded as PackedScene).instantiate()
	if root == null:
		return { "ok": false, "error": "Failed to instantiate scene at %s." % res_path }

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

func to_res_path(relative_path: String) -> String:
	if relative_path.begins_with("res://"):
		return relative_path
	return "res://" + relative_path.replace("\\", "/").lstrip("/")

func emit_result(result: Dictionary) -> void:
	print(RESULT_MARKER + JSON.stringify(result))
