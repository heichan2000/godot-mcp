@tool
extends "op_base.gd"

## Scene op handlers, split out of server.gd (#70). Bodies are
## verbatim moves; shared helpers live in op_base.gd, shared state on server.


## Create a .tscn with the chosen root type and open it (REQ-C-01). Refuses to
## overwrite an existing scene; the new scene is written to disk (so it reloads
## clean and is import-registered) then opened as the current tab.
func _op_scene_create(params: Dictionary) -> Dictionary:
	var res_path := _scene_res_path(str(params.get("scene_path", "")))
	if res_path == "":
		return _err("path_escape", "scene_path is not a valid in-project res:// path.", [
			"Pass a res:// path with no '..' segments.",
		])
	if FileAccess.file_exists(res_path):
		return _err("scene_exists", "A scene already exists at %s." % res_path, [
			"Choose a different scene_path, or open the existing scene with open_scene.",
		])
	var type := str(params.get("root_node_type", "Node"))
	if type == "":
		type = "Node"
	if not ClassDB.class_exists(type) or not ClassDB.can_instantiate(type) or not ClassDB.is_parent_class(type, "Node"):
		return _err("invalid_root_type", "root_node_type '%s' is not an instantiable Node class." % type, [
			"Use a concrete Node subclass such as Node, Node2D, Node3D, or Control.",
		])
	var root := ClassDB.instantiate(type) as Node
	if root == null:
		return _err("invalid_root_type", "Could not instantiate root_node_type '%s'." % type, [
			"Use a concrete Node subclass such as Node, Node2D, Node3D, or Control.",
		])
	root.name = type
	var dir_path := res_path.get_base_dir()
	if dir_path != "" and not DirAccess.dir_exists_absolute(dir_path):
		DirAccess.make_dir_recursive_absolute(dir_path)
	var packed := PackedScene.new()
	var pack_err := packed.pack(root)
	if pack_err != OK:
		root.free()
		return _err("save_failed", "Failed to pack the new scene (error %d)." % pack_err, [
			"Retry, or report this if it persists.",
		])
	var save_err := ResourceSaver.save(packed, res_path)
	root.free()
	if save_err != OK:
		return _err("save_failed", "Failed to write %s (error %d)." % [res_path, save_err], [
			"Check that the target directory is writable.",
		])
	EditorInterface.get_resource_filesystem().update_file(res_path)
	EditorInterface.open_scene_from_path(res_path)
	return {"result": {"scene_path": res_path, "root_node_type": type, "created": true}}


## Open/focus a scene tab and make it current (REQ-C-03). open_scene_from_path
## focuses an already-open tab rather than duplicating it.
func _op_scene_open(params: Dictionary) -> Dictionary:
	var res_path := _scene_res_path(str(params.get("scene_path", "")))
	if res_path == "":
		return _err("path_escape", "scene_path is not a valid in-project res:// path.", [
			"Pass a res:// path with no '..' segments.",
		])
	if not FileAccess.file_exists(res_path):
		return _err("scene_not_found", "No scene exists at %s." % res_path, [
			"Create it with create_scene, or check the path for typos.",
		])
	EditorInterface.open_scene_from_path(res_path)
	return {"result": {"scene_path": res_path, "current": res_path}}


## Open scene tabs with their dirty flags + which is current (REQ-C-02/C-03).
func _op_scene_list_open() -> Dictionary:
	var current := _current_scene_path()
	var scenes: Array = []
	for p in EditorInterface.get_open_scenes():
		var res_p := str(p)
		scenes.append({"path": res_p, "dirty": bool(server._dirty_scenes.get(res_p, false))})
	var current_value: Variant = current if current != "" else null
	return {"result": {"current": current_value, "scenes": scenes, "count": scenes.size()}}


## Mark the current scene unsaved (internal op; the seam node ops reuse). Sets
## the ledger AND the editor's own tab marker so a human sees the * immediately.
func _op_scene_mark_unsaved() -> Dictionary:
	var current := _current_scene_path()
	if current == "":
		return _err("no_current_scene", "There is no current saved scene to mark unsaved.", [
			"Open or create a scene first.",
		])
	server._dirty_scenes[current] = true
	EditorInterface.mark_scene_as_unsaved()
	return {"result": {"scene_path": current, "dirty": true}}


## Save current / named / save-as / all (REQ-C-02) and clear the dirty ledger for
## what was saved. A named scene is focused first so the editor's save targets it.
func _op_scene_save(params: Dictionary) -> Dictionary:
	if bool(params.get("all", false)):
		EditorInterface.save_all_scenes()
		var saved_all: Array = []
		for p in EditorInterface.get_open_scenes():
			var res_all := str(p)
			server._dirty_scenes.erase(res_all)
			saved_all.append(res_all)
		var cur_all := _current_scene_path()
		return {"result": {"saved": saved_all, "current": cur_all if cur_all != "" else null, "all": true}}

	var target := str(params.get("scene_path", ""))
	if target != "":
		if not (target in EditorInterface.get_open_scenes()):
			return _err("scene_not_open", "Scene %s is not open; open it before saving." % target, [
				"Open it with open_scene first, or omit scene_path to save the current scene.",
			])
		if _current_scene_path() != target:
			EditorInterface.open_scene_from_path(target)

	var current := _current_scene_path()
	if current == "":
		return _err("no_current_scene", "There is no current scene to save.", [
			"Open or create a scene first, or pass scene_path.",
		])

	var new_path := str(params.get("new_path", ""))
	if new_path != "":
		EditorInterface.save_scene_as(new_path)
		server._dirty_scenes.erase(current)
		server._dirty_scenes.erase(new_path)
		return {"result": {"saved": [new_path], "current": new_path, "all": false}}

	var err := EditorInterface.save_scene()
	if err != OK:
		return _err("save_failed", "Failed to save %s (error %d)." % [current, err], [
			"Check that the scene's file is writable.",
		])
	server._dirty_scenes.erase(current)
	return {"result": {"saved": [current], "current": current, "all": false}}


## Close a scene tab (REQ-C-03). close_scene() closes the CURRENT scene and
## always discards, so we (1) resolve the target (named or current), (2) refuse
## if it is dirty and discard is false, (3) focus it, then (4) close.
func _op_scene_close(params: Dictionary) -> Dictionary:
	var discard := bool(params.get("discard", false))
	var target := str(params.get("scene_path", ""))
	if target == "":
		target = _current_scene_path()
	if target == "":
		return _err("no_current_scene", "There is no current scene to close.", [
			"Open a scene first, or pass scene_path.",
		])
	if not (target in EditorInterface.get_open_scenes()):
		return _err("scene_not_open", "Scene %s is not open." % target, [
			"Pass the path of a scene that is currently open (see get_open_scenes).",
		])
	if bool(server._dirty_scenes.get(target, false)) and not discard:
		return _err("unsaved_changes", "%s has unsaved changes." % target, [
			"Save it with save_scene first, or pass discard:true to close and lose the changes.",
		])
	if _current_scene_path() != target:
		EditorInterface.open_scene_from_path(target)
	EditorInterface.close_scene()
	server._dirty_scenes.erase(target)
	var current := _current_scene_path()
	return {"result": {"scene_path": target, "closed": true, "current": current if current != "" else null}}


## Live edited-scene tree readback (REQ-C-10): 1.0-parity name/type/path plus
## script + instance markers, read from the LIVE tree so unsaved edits show.
## Instanced children are walked too (their root carries the instance marker).
func _op_scene_get_tree() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return _err("no_current_scene", "There is no open scene to read.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var current := _current_scene_path()
	var current_value: Variant = current if current != "" else null
	return {"result": {"scene_path": current_value, "tree": _tree_node(root, root)}}


## One tree node: same {name,type,path,children} 1.0 emitted, plus
## script (resource_path of the attached script, null when none/built-in) and
## instance (scene_file_path for a non-root instanced child, null otherwise).
func _tree_node(root: Node, node: Node) -> Dictionary:
	var children: Array = []
	for child in node.get_children():
		children.append(_tree_node(root, child))
	var script_value: Variant = null
	var attached: Script = node.get_script() as Script
	if attached != null and attached.resource_path != "":
		script_value = attached.resource_path
	var instance_value: Variant = null
	if node != root and node.scene_file_path != "":
		instance_value = node.scene_file_path
	return {
		"name": (node.name as String),
		"type": node.get_class(),
		"path": str(root.get_path_to(node)),
		"script": script_value,
		"instance": instance_value,
		"children": children,
	}
