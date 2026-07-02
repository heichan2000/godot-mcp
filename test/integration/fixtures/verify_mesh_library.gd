extends SceneTree
##
## Test-only helper (NOT part of the shipped dispatcher): loads a MeshLibrary
## resource and reports whether it loaded correctly plus each item's id,
## name, and whether it has a mesh assigned. Used by the integration suite
## to round-trip verify export_mesh_library's real effect on the saved
## resource, independent of the operations.gd dispatcher under test.
##
## Invoked as:
##   godot --headless --path <project> --script verify_mesh_library.gd -- <res-output-path>

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var output_path: String = args[0] if args.size() > 0 else ""

	var res: Variant = load(output_path)
	var ok := res != null and res is MeshLibrary
	var items: Array = []

	if ok:
		var lib := res as MeshLibrary
		for id in lib.get_item_list():
			items.append({
				"id": id,
				"name": lib.get_item_name(id),
				"has_mesh": lib.get_item_mesh(id) != null,
			})

	print("GODOT_MCP_VERIFY:" + JSON.stringify({
		"ok": ok,
		"item_count": items.size(),
		"items": items,
	}))
	quit(0 if ok else 1)
