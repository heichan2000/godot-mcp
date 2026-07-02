extends SceneTree
##
## Test-only helper (NOT part of the shipped dispatcher): loads a scene by
## its res:// path and reports whether it loaded as a PackedScene, plus the
## class name of its instantiated root node. Used by the integration suite
## to round-trip verify that `create_scene`'s output actually opens in
## Godot, independent of the operations.gd dispatcher under test.
##
## Invoked as: godot --headless --path <project> --script verify_scene_loads.gd -- <res-scene-path>

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var scene_path: String = args[0] if args.size() > 0 else ""
	var res: Variant = load(scene_path)
	var ok := res != null and res is PackedScene
	var root_class := ""
	if ok:
		var instance: Node = (res as PackedScene).instantiate()
		root_class = instance.get_class()
		instance.free()
	print("GODOT_MCP_VERIFY:" + JSON.stringify({ "ok": ok, "root_class": root_class }))
	quit(0 if ok else 1)
