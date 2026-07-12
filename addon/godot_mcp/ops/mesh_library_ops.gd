@tool
extends "op_base.gd"

## MeshLibrary export (REQ-G-01) - 1.0 parity: walk a scene's MeshInstance3D
## nodes (root included) and save the assigned meshes as MeshLibrary items
## (item name = node name). Loads the scene from disk - NOT the edited scene -
## and never registers UndoRedo: the output is a derived build artifact, so
## overwriting an existing file at output_path is allowed by design (contrast
## scene_ops' create-refusal). Emits progress frames (REQ-A-11) around the
## load/collect/save phases. Registering the saved file with the editor's
## filesystem is conditional: when output_path's parent directory is already
## indexed, a plain update_file() is enough and the op returns immediately;
## when the parent directory is brand-new (update_file() cannot discover a
## directory the filesystem tree doesn't know about yet), the op kicks off a
## full scan() and defers the response via RegisterTask until it completes.


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
	# update_file() only refreshes a path inside a directory the filesystem
	# tree already indexes - it cannot discover a brand-new directory (e.g.
	# the first export into res://libraries). When the parent dir is already
	# indexed (overwrite/re-export case), update_file() is enough and we
	# return immediately. Otherwise defer to RegisterTask, which kicks off a
	# full scan() and waits for it so the new directory gets indexed too.
	var result := {"scene_path": scene_path, "output_path": output_path, "item_names": item_names}
	var fs := EditorInterface.get_resource_filesystem()
	if fs.get_filesystem_path(output_path.get_base_dir()) != null:
		fs.update_file(output_path)
		return {"result": result}
	fs.scan()
	return {"task": RegisterTask.new(server, id, fs, result)}


## Depth-first MeshInstance3D collection, root included; instances with no
## mesh assigned are skipped - an item with a null mesh is useless (1.0 rule).
func _collect_mesh_instances(node: Node, out: Array) -> void:
	if node is MeshInstance3D and (node as MeshInstance3D).mesh != null:
		out.append(node)
	for child in node.get_children():
		_collect_mesh_instances(child, out)


## Deferred registration for an export into a brand-new directory (REQ-A-11):
## mirrors project_ops.gd's ScanTask, but waits on a scan() kicked off after
## ResourceSaver.save has already succeeded, then replies with the result dict
## captured at construction rather than a fresh scan-outcome shape. null =
## still scanning; a {result} dict = done. A scan that finishes instantly is
## fine - it just responds on its first tick.
class RegisterTask:
	extends RefCounted

	var _server: Node
	var _id: Variant
	var _fs: EditorFileSystem
	var _result: Dictionary
	var _last_percent := -1
	var _frames_since_emit := 0

	func _init(srv: Node, id: Variant, fs: EditorFileSystem, result: Dictionary) -> void:
		_server = srv
		_id = id
		_fs = fs
		_result = result

	func tick() -> Variant:
		if _fs.is_scanning():
			var percent := int(_fs.get_scanning_progress() * 100.0)
			_frames_since_emit += 1
			# Throttle: emit on change, or every ~30 frames as a heartbeat.
			if percent != _last_percent or _frames_since_emit >= 30:
				_server.emit_progress(_id, {"stage": "register", "current": percent, "total": 100})
				_last_percent = percent
				_frames_since_emit = 0
			return null
		return {"result": _result}
