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
	# force_readable_name=true (real-editor bug found in #70's integration run):
	# Node.add_child's default (false) resolves a sibling-name collision with an
	# internal generated name like "@Node2D@18502" instead of a readable
	# auto-suffix like "Fresh2". An agent (or a human reading get_scene_tree)
	# needs the readable form to keep addressing the node by name.
	undo.add_do_method(parent, "add_child", node, true)
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


## Resolve a caller-supplied node path against the edited scene root.
## "" and "." address the root; null means not found (caller emits the error).
func _resolve_node(scene_root: Node, node_path: String) -> Node:
	if node_path == "" or node_path == ".":
		return scene_root
	return scene_root.get_node_or_null(NodePath(node_path))


## Nodes in `node`'s subtree (inclusive) whose owner is `owner`. Leaving the
## tree clears exactly these owner links (nodes inside an instanced child are
## owned by that child, which stays an ancestor within the detached subtree),
## so this is the set an undo must re-own for the subtree to serialize again.
func _collect_owned(node: Node, owner: Node, out: Array) -> void:
	if node.owner == owner:
		out.append(node)
	for child in node.get_children():
		_collect_owned(child, owner, out)


## Pre-order manifest of a subtree - name, type, and path relative to the
## scene root - captured BEFORE a destructive op so the response can report
## exactly what went away (REQ-M-04).
func _subtree_manifest(scene_root: Node, node: Node, out: Array) -> void:
	out.append({
		"path": str(scene_root.get_path_to(node)),
		"name": str(node.name),
		"type": node.get_class(),
	})
	for child in node.get_children():
		_subtree_manifest(scene_root, child, out)


## node/remove: delete a node and its subtree from the edited scene
## (REQ-C-05), reporting a manifest of everything removed (REQ-M-04) and
## registered with the editor's UndoRedo (REQ-M-05). The undo chain mirrors
## the editor's own SceneTreeDock delete - add_child, then move_child to the
## original index, then set_owner for every broken owner link (UndoRedo runs
## method lists in registration order); add_undo_reference keeps the detached
## subtree alive while the action sits in history.
func _op_node_remove(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to remove a node from.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var node_path := str(params.get("node_path", ""))
	var node := _resolve_node(scene_root, node_path)
	if node == null:
		return _err("node_not_found", "No node exists at node_path '%s'." % node_path, [
			"Read the tree with get_scene_tree to see valid node paths.",
		])
	if node == scene_root:
		return _err("cannot_remove_root", "The scene root cannot be removed.", [
			"Remove a child of the root, or close the scene instead.",
		])
	var manifest: Array = []
	_subtree_manifest(scene_root, node, manifest)
	var owned: Array = []
	_collect_owned(node, scene_root, owned)
	var parent := node.get_parent()
	var index := node.get_index()
	var undo := EditorInterface.get_editor_undo_redo()
	undo.create_action("Remove %s" % node.name, UndoRedo.MERGE_DISABLE, scene_root)
	undo.add_do_method(parent, "remove_child", node)
	undo.add_undo_method(parent, "add_child", node, true)
	undo.add_undo_method(parent, "move_child", node, index)
	for owned_node in owned:
		undo.add_undo_method(owned_node, "set_owner", scene_root)
	undo.add_undo_reference(node)
	undo.commit_action()
	server._dirty_scenes[scene_root.scene_file_path] = true
	return {"result": {
		"node_path": manifest[0]["path"],
		"removed_subtree": manifest,
		"removed_count": manifest.size(),
	}}


## node/duplicate: copy a node and its subtree in place as a sibling right
## after the source (REQ-C-05), UndoRedo-registered (REQ-M-05). duplicate()
## copies structure and names but NOT ownership, so the do chain re-owns the
## copy's counterparts of every source node the scene root owned - mapped by
## relative path (blanket-owning every descendant would corrupt instanced
## children's serialization). add_child(force_readable_name=true) resolves
## name collisions with a readable suffix; the response reports the actual
## resulting name and path.
func _op_node_duplicate(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to duplicate a node in.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var node_path := str(params.get("node_path", ""))
	var node := _resolve_node(scene_root, node_path)
	if node == null:
		return _err("node_not_found", "No node exists at node_path '%s'." % node_path, [
			"Read the tree with get_scene_tree to see valid node paths.",
		])
	if node == scene_root:
		return _err("cannot_duplicate_root", "The scene root cannot be duplicated.", [
			"Duplicate a child of the root, or create a new scene with create_scene.",
		])
	var parent := node.get_parent()
	var dup := node.duplicate()
	if dup == null:
		return _err("duplicate_failed", "Godot could not duplicate the node at '%s'." % node_path, [
			"Check the editor Output panel for script errors on the node.",
		])
	var requested := str(params.get("new_name", ""))
	dup.name = requested if requested != "" else str(node.name)
	var owned_src: Array = []
	_collect_owned(node, scene_root, owned_src)
	var to_own: Array = [dup]
	for src in owned_src:
		if src == node:
			continue
		var counterpart := dup.get_node_or_null(node.get_path_to(src))
		if counterpart != null and not to_own.has(counterpart):
			to_own.append(counterpart)
	var undo := EditorInterface.get_editor_undo_redo()
	undo.create_action("Duplicate %s" % node.name, UndoRedo.MERGE_DISABLE, scene_root)
	undo.add_do_method(parent, "add_child", dup, true)
	undo.add_do_method(parent, "move_child", dup, node.get_index() + 1)
	for owned_node in to_own:
		undo.add_do_method(owned_node, "set_owner", scene_root)
	undo.add_do_reference(dup)
	undo.add_undo_method(parent, "remove_child", dup)
	undo.commit_action()
	server._dirty_scenes[scene_root.scene_file_path] = true
	return {"result": {
		"node_path": str(scene_root.get_path_to(dup)),
		"name": str(dup.name),
		"source_path": str(scene_root.get_path_to(node)),
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


## node/move: reparent and/or reorder a node (REQ-C-05), UndoRedo-registered
## (REQ-M-05). Reparenting uses Node.reparent (which preserves the global or
## local transform per the flag); owner links are re-set in both chains as a
## defense - reparent preserves them on supported Godot versions, and the
## set_owner calls are no-ops when it already did. The cycle guard runs
## before any mutation: moving a node into its own subtree would detach it
## from the scene entirely. index is clamped to the valid range at action
## build time (post-reparent the parent has one more child, so its build-time
## child count is the last valid slot).
func _op_node_move(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to move a node in.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var node_path := str(params.get("node_path", ""))
	var node := _resolve_node(scene_root, node_path)
	if node == null:
		return _err("node_not_found", "No node exists at node_path '%s'." % node_path, [
			"Read the tree with get_scene_tree to see valid node paths.",
		])
	if node == scene_root:
		return _err("cannot_move_root", "The scene root cannot be moved.", [
			"Move a child of the root instead.",
		])
	var has_new_parent := params.has("new_parent_path")
	var has_index := params.has("index")
	if not has_new_parent and not has_index:
		return _err("nothing_to_do", "A move needs a destination: pass new_parent_path and/or index.", [
			"Pass new_parent_path to reparent the node.",
			"Pass index to reorder it under its current parent.",
		])
	var old_parent := node.get_parent()
	var old_index := node.get_index()
	var new_parent := old_parent
	if has_new_parent:
		var new_parent_path := str(params.get("new_parent_path", ""))
		new_parent = _resolve_node(scene_root, new_parent_path)
		if new_parent == null:
			return _err("parent_not_found", "No node exists at new_parent_path '%s'." % new_parent_path, [
				"Read the tree with get_scene_tree to see valid node paths.",
			])
		if new_parent == node or node.is_ancestor_of(new_parent):
			return _err("cycle_move", "Cannot move '%s' into its own subtree." % node.name, [
				"Pick a new_parent_path outside the node's subtree.",
			])
	var keep_global := bool(params.get("keep_global_transform", true))
	var reparenting := new_parent != old_parent
	var owned: Array = []
	_collect_owned(node, scene_root, owned)
	var undo := EditorInterface.get_editor_undo_redo()
	undo.create_action("Move %s" % node.name, UndoRedo.MERGE_DISABLE, scene_root)
	if reparenting:
		undo.add_do_method(node, "reparent", new_parent, keep_global)
		for owned_node in owned:
			undo.add_do_method(owned_node, "set_owner", scene_root)
		if has_index:
			undo.add_do_method(new_parent, "move_child", node, clampi(int(params.get("index", 0)), 0, new_parent.get_child_count()))
		undo.add_undo_method(node, "reparent", old_parent, keep_global)
		undo.add_undo_method(old_parent, "move_child", node, old_index)
		for owned_node in owned:
			undo.add_undo_method(owned_node, "set_owner", scene_root)
	else:
		undo.add_do_method(old_parent, "move_child", node, clampi(int(params.get("index", 0)), 0, old_parent.get_child_count() - 1))
		undo.add_undo_method(old_parent, "move_child", node, old_index)
	undo.commit_action()
	server._dirty_scenes[scene_root.scene_file_path] = true
	var transform_handling := "unchanged"
	if reparenting:
		if node is Node2D or node is Node3D or node is Control:
			transform_handling = "kept_global_transform" if keep_global else "kept_local_transform"
		else:
			transform_handling = "no_transform"
	return {"result": {
		"node_path": str(scene_root.get_path_to(node)),
		"parent_path": str(scene_root.get_path_to(node.get_parent())),
		"index": node.get_index(),
		"transform_handling": transform_handling,
	}}


## node/rename: rename a node (REQ-C-05), UndoRedo-registered (REQ-M-05).
## The root may be renamed (its path stays "."). Characters Godot would
## silently sanitize out of a node name are rejected instead; a sibling
## collision auto-suffixes, so the response reports the ACTUAL resulting
## name and path plus the old path - every path the caller held into this
## subtree just changed.
func _op_node_rename(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to rename a node in.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var node_path := str(params.get("node_path", ""))
	var node := _resolve_node(scene_root, node_path)
	if node == null:
		return _err("node_not_found", "No node exists at node_path '%s'." % node_path, [
			"Read the tree with get_scene_tree to see valid node paths.",
		])
	var new_name := str(params.get("new_name", ""))
	if new_name == "":
		return _err("invalid_name", "new_name must not be empty.", [
			"Pass the node's new name in new_name.",
		])
	for bad_char in [".", "/", ":", "@", "%", "\""]:
		if new_name.contains(bad_char):
			return _err("invalid_name", "new_name '%s' contains a character node names cannot hold." % new_name, [
				"Use a name without . / : @ % or quote characters.",
			])
	var old_name := str(node.name)
	var old_path := str(scene_root.get_path_to(node))
	var undo := EditorInterface.get_editor_undo_redo()
	undo.create_action("Rename %s to %s" % [old_name, new_name], UndoRedo.MERGE_DISABLE, scene_root)
	undo.add_do_method(node, "set_name", new_name)
	undo.add_undo_method(node, "set_name", old_name)
	undo.commit_action()
	server._dirty_scenes[scene_root.scene_file_path] = true
	return {"result": {
		"node_path": str(scene_root.get_path_to(node)),
		"name": str(node.name),
		"old_path": old_path,
	}}
