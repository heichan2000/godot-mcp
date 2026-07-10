@tool
extends "op_base.gd"

## Node op handlers, split out of server.gd (#70). Bodies are
## verbatim moves; shared helpers live in op_base.gd, shared state on server.


## Add a node of a requested type under a parent in the edited scene (REQ-C-04),
## registered with the editor's UndoRedo so a human can Ctrl+Z it (REQ-M-05).
## The ClassDB gate carries forward from 1.0 verbatim: real class, Node-derived,
## instantiable - rejected BEFORE the tree is touched. The node's owner is set to
## the scene root so it serializes into the .tscn on save.
func _op_node_add(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to add a node to.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var type := str(params.get("node_type", ""))
	if not ClassDB.class_exists(type) or not ClassDB.is_parent_class(type, "Node") or not ClassDB.can_instantiate(type):
		return _err("invalid_node_type", "node_type '%s' is not an instantiable Node class." % type, [
			"Use a concrete Node subclass such as Node, Node2D, Sprite2D, or Control.",
			"Check the spelling against Godot's class list.",
		])
	var parent: Node = scene_root
	var parent_path := str(params.get("parent_path", ""))
	if parent_path != "" and parent_path != "." and parent_path != "/root":
		parent = scene_root.get_node_or_null(NodePath(parent_path))
		if parent == null:
			return _err("parent_not_found", "No node exists at parent_path '%s'." % parent_path, [
				"Pass a node path relative to the scene root, e.g. \".\" or \"Player\".",
				"Omit parent_path to add under the scene root.",
			])
	var node := ClassDB.instantiate(type) as Node
	if node == null:
		return _err("invalid_node_type", "Could not instantiate node_type '%s'." % type, [
			"Use a concrete Node subclass such as Node, Node2D, or Control.",
		])
	var requested_name := str(params.get("node_name", ""))
	node.name = requested_name if requested_name != "" else type
	var undo := EditorInterface.get_editor_undo_redo()
	undo.create_action("Add %s" % node.name, UndoRedo.MERGE_DISABLE, scene_root)
	undo.add_do_method(parent, "add_child", node)
	undo.add_do_method(node, "set_owner", scene_root)
	undo.add_do_reference(node)
	undo.add_undo_method(parent, "remove_child", node)
	undo.commit_action()
	server._dirty_scenes[scene_root.scene_file_path] = true
	return {"result": {
		"node_path": str(scene_root.get_path_to(node)),
		"name": str(node.name),
		"node_type": type,
		"parent_path": str(scene_root.get_path_to(parent)),
	}}


## Step the CURRENT scene's editor undo history back one action (REQ-M-05 test
## seam; internal op, no MCP tool). This is the very history Ctrl+Z drives.
func _op_edit_undo() -> Dictionary:
	return _edit_history_step(true)


## Step the CURRENT scene's editor undo history forward one action (redo).
func _op_edit_redo() -> Dictionary:
	return _edit_history_step(false)


## Resolve the edited scene's own UndoRedo (via its history id) and step it.
## get_history_undo_redo is advanced API, but stepping the real scene history is
## exactly what proves an agent mutation is registered there. Returns the bool
## the step yielded (false at a history boundary is a no-op, not an error).
func _edit_history_step(is_undo: bool) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene whose history to step.", [
			"Open or create a scene first.",
		])
	var manager := EditorInterface.get_editor_undo_redo()
	var hist_id := manager.get_object_history_id(scene_root)
	var ur := manager.get_history_undo_redo(hist_id)
	var stepped := ur.undo() if is_undo else ur.redo()
	return {"result": {"stepped": stepped, "undo": is_undo}}
