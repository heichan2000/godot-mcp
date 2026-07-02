extends SceneTree
##
## Test-only helper (NOT part of the shipped dispatcher): loads a scene,
## finds a node by path relative to the instantiated root, and reports
## whether its `texture` property is assigned plus the assigned texture's
## resource_path. Used by the integration suite to round-trip verify
## load_sprite's real effect on the saved .tscn, independent of the
## operations.gd dispatcher under test.
##
## Invoked as:
##   godot --headless --path <project> --script verify_sprite_texture.gd -- <res-scene-path> <node-path>
## node_path may be empty to mean "the scene root itself".

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var scene_path: String = args[0] if args.size() > 0 else ""
	var node_path: String = args[1] if args.size() > 1 else ""

	var res: Variant = load(scene_path)
	var ok := res != null and res is PackedScene
	var node_found := false
	var node_class := ""
	var has_texture := false
	var texture_resource_path := ""

	if ok:
		var instance: Node = (res as PackedScene).instantiate()
		var target: Node = instance
		if not node_path.is_empty():
			target = instance.get_node_or_null(NodePath(node_path))
		if target != null:
			node_found = true
			node_class = target.get_class()
			var texture: Variant = target.get("texture")
			if texture != null:
				has_texture = true
				texture_resource_path = (texture as Resource).resource_path
		instance.free()

	print("GODOT_MCP_VERIFY:" + JSON.stringify({
		"ok": ok,
		"node_found": node_found,
		"node_class": node_class,
		"has_texture": has_texture,
		"texture_resource_path": texture_resource_path,
	}))
	quit(0 if ok and node_found else 1)
