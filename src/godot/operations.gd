extends SceneTree

# operations.gd — single versioned GDScript dispatcher for godot-mcp.
#
# Invoked headlessly as:
#   godot --headless --path <project> --script operations.gd <operation> <json_params>
#
# Params arrive as a single JSON string argument (data, never interpolated).
# Each operation is a small named function. Path containment is RE-CHECKED here
# (defense in depth) before any file access.
#
# Versioned: bump DISPATCHER_VERSION on any breaking change to the contract.

const DISPATCHER_VERSION := "0.0.0"

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 1:
		_fail("missing operation argument")
		return

	var operation: String = args[0]
	var params: Dictionary = {}
	if args.size() >= 2:
		var parsed: Variant = JSON.parse_string(args[1])
		if typeof(parsed) == TYPE_DICTIONARY:
			params = parsed

	match operation:
		# TODO(M1): create_scene, add_node, load_sprite, save_scene,
		#           export_mesh_library, get_project_info, get_godot_version
		# TODO(M2): get_scene_tree, read_node_properties, get_script_errors,
		#           list_resources, get_uid, update_project_uids
		_:
			_fail("unknown operation: %s" % operation)

	quit()


# --- helpers ---------------------------------------------------------------

# Re-check that `rel` resolves inside `project_root` (defense in depth).
# TODO(M2): implement containment + symlink-escape rejection in GDScript.
func _assert_inside_root(_project_root: String, _rel: String) -> bool:
	return true

func _ok(data: Variant) -> void:
	print(JSON.stringify({"ok": true, "data": data}))

func _fail(message: String) -> void:
	printerr(JSON.stringify({"ok": false, "error": message}))
