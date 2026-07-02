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

	if not ClassDB.class_exists(root_node_type) \
			or not ClassDB.is_parent_class(root_node_type, "Node") \
			or not ClassDB.can_instantiate(root_node_type):
		return { "ok": false, "error": "root_node_type is not an instantiable Node class: %s" % root_node_type }

	var res_path := to_res_path(scene_path)
	var dir_path := res_path.get_base_dir()
	if not dir_path.is_empty() and not DirAccess.dir_exists_absolute(dir_path):
		var mkdir_err := DirAccess.make_dir_recursive_absolute(dir_path)
		if mkdir_err != OK:
			return { "ok": false, "error": "Failed to create parent directory %s: error %d" % [dir_path, mkdir_err] }

	var root_node: Node = ClassDB.instantiate(root_node_type)
	root_node.name = res_path.get_file().get_basename()

	var packed := PackedScene.new()
	var pack_err := packed.pack(root_node)
	root_node.free()
	if pack_err != OK:
		return { "ok": false, "error": "Failed to pack scene: error %d" % pack_err }

	var save_err := ResourceSaver.save(packed, res_path)
	if save_err != OK:
		return { "ok": false, "error": "Failed to save scene to %s: error %d" % [res_path, save_err] }

	return { "ok": true, "result": { "scene_path": res_path, "root_node_type": root_node_type } }

func to_res_path(relative_path: String) -> String:
	if relative_path.begins_with("res://"):
		return relative_path
	return "res://" + relative_path.replace("\\", "/").lstrip("/")

func emit_result(result: Dictionary) -> void:
	print(RESULT_MARKER + JSON.stringify(result))
