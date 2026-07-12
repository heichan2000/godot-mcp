@tool
extends "op_base.gd"

## MeshLibrary export (REQ-G-01) - 1.0 parity: walk a scene's MeshInstance3D
## nodes (root included) and save the assigned meshes as MeshLibrary items
## (item name = node name). Loads the scene from disk - NOT the edited scene -
## and never registers UndoRedo: the output is a derived build artifact, so
## overwriting an existing file at output_path is allowed by design (contrast
## scene_ops' create-refusal). Emits progress frames (REQ-A-11) around the
## load/collect/save phases.


func _op_export_mesh_library(params: Dictionary, id: Variant) -> Dictionary:
	var scene_path := _scene_res_path(str(params.get("scene_path", "")))
	if scene_path == "":
		return _err("path_escape", "scene_path must be a res:// path inside the project.", [
			"Pass a res:// scene path, e.g. res://scenes/meshes.tscn.",
		])
	var output_path := _scene_res_path(str(params.get("output_path", "")))
	if output_path == "":
		return _err("path_escape", "output_path must be a res:// path inside the project.", [
			"Pass a res:// output path, e.g. res://libraries/meshes.res.",
		])
	var names: Array = []
	var raw_names: Variant = params.get("mesh_item_names", [])
	if raw_names is Array:
		for entry in raw_names:
			names.append(str(entry))
	if not FileAccess.file_exists(scene_path):
		return _err("scene_not_found", "No scene exists at %s." % scene_path, [
			"Check the path with list_resources - it must name an existing scene file.",
		])
	server.emit_progress(id, {"stage": "load", "message": scene_path})
	var packed: Variant = ResourceLoader.load(scene_path)
	if packed == null or not (packed is PackedScene):
		return _err("scene_not_found", "The resource at %s is not a loadable scene." % scene_path, [
			"Pass a PackedScene (.tscn/.scn) path.",
		])
	var root: Node = (packed as PackedScene).instantiate()
	if root == null:
		return _err("scene_not_found", "The scene at %s failed to instantiate." % scene_path, [
			"Open the scene in the editor and fix any load errors first.",
		])
	var instances: Array = []
	_collect_mesh_instances(root, instances)
	if instances.is_empty():
		root.free()
		return _err("no_meshes", "Scene at %s contains no MeshInstance3D nodes with an assigned mesh." % scene_path, [
			"Add MeshInstance3D nodes with meshes assigned, or pick another scene.",
		])
	var selected: Array = instances
	if not names.is_empty():
		var available: Array = []
		for mi in instances:
			available.append(str((mi as MeshInstance3D).name))
		selected = []
		for mi in instances:
			if names.has(str((mi as MeshInstance3D).name)):
				selected.append(mi)
		if selected.is_empty():
			root.free()
			return _err(
				"mesh_item_names_unmatched",
				"None of the requested mesh_item_names matched a mesh item in the scene: %s. Available item names: %s" % [JSON.stringify(names), JSON.stringify(available)],
				["Pick names from the available list, or omit mesh_item_names to export every mesh."],
			)
	var library := MeshLibrary.new()
	var item_names: Array = []
	var item_id := 0
	var total := selected.size()
	for mi_variant in selected:
		var mi: MeshInstance3D = mi_variant
		if item_id % 25 == 0:
			server.emit_progress(id, {"stage": "collect", "current": item_id, "total": total})
		library.create_item(item_id)
		library.set_item_name(item_id, mi.name)
		library.set_item_mesh(item_id, mi.mesh)
		item_names.append(str(mi.name))
		item_id += 1
	root.free()
	var dir_err := DirAccess.make_dir_recursive_absolute(output_path.get_base_dir())
	if dir_err != OK and dir_err != ERR_ALREADY_EXISTS:
		return _err("save_failed", "Could not create the parent directory for %s (error %d)." % [output_path, dir_err], [
			"Check that the project directory is writable.",
		])
	server.emit_progress(id, {"stage": "save", "message": output_path})
	var save_err := ResourceSaver.save(library, output_path)
	if save_err != OK:
		return _err("save_failed", "Failed to save the mesh library to %s: error %d." % [output_path, save_err], [
			"Check that the output directory is writable and the extension is .res or .tres.",
		])
	# Register the new file with the editor's filesystem so list_resources
	# sees it without a manual rescan (v2 nicety - 1.0 had no live editor).
	EditorInterface.get_resource_filesystem().update_file(output_path)
	return {"result": {"scene_path": scene_path, "output_path": output_path, "item_names": item_names}}


## Depth-first MeshInstance3D collection, root included; instances with no
## mesh assigned are skipped - an item with a null mesh is useless (1.0 rule).
func _collect_mesh_instances(node: Node, out: Array) -> void:
	if node is MeshInstance3D and (node as MeshInstance3D).mesh != null:
		out.append(node)
	for child in node.get_children():
		_collect_mesh_instances(child, out)
