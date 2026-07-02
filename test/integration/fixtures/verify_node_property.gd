extends SceneTree
##
## Test-only helper (NOT part of the shipped dispatcher): loads a scene,
## finds a node by path relative to the instantiated root, and reports its
## class plus - when a property name is given - that property's var_to_str
## encoding. Used by the integration suite to round-trip verify add_node's
## real effect on the saved .tscn, independent of the operations.gd
## dispatcher under test.
##
## Invoked as:
##   godot --headless --path <project> --script verify_node_property.gd -- <res-scene-path> <node-path> [<property-name>]
## node_path may be empty to mean "the scene root itself".

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var scene_path: String = args[0] if args.size() > 0 else ""
	var node_path: String = args[1] if args.size() > 1 else ""
	var property_name: String = args[2] if args.size() > 2 else ""

	var res: Variant = load(scene_path)
	var ok := res != null and res is PackedScene
	var node_found := false
	var node_class := ""
	var property_value_str := ""

	if ok:
		var instance: Node = (res as PackedScene).instantiate()
		var target: Node = instance
		if not node_path.is_empty():
			target = instance.get_node_or_null(NodePath(node_path))
		if target != null:
			node_found = true
			node_class = target.get_class()
			if not property_name.is_empty():
				property_value_str = var_to_str(target.get(property_name))
		instance.free()

	print("GODOT_MCP_VERIFY:" + JSON.stringify({
		"ok": ok,
		"node_found": node_found,
		"node_class": node_class,
		"property_value_str": property_value_str,
	}))
	quit(0 if ok and node_found else 1)
