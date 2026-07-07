@tool
extends Node

## Loopback WebSocket bridge server (REQ-A-02). One client at a time; a
## versioned hello on connect; requests execute serially in arrival order
## (REQ-A-12) - one op per editor frame, popped from _queue.
##
## PROTOCOL_VERSION mirrors src/bridge/protocol.ts - bump both together.

const PROTOCOL_VERSION := 1
const DEFAULT_PORT := 6510
const PORT_SETTING := "godot_mcp/network/port"

var _tcp := TCPServer.new()
var _peer: WebSocketPeer = null
var _hello_sent := false
var _queue: Array[Dictionary] = []
var _start_ms := 0

## Per-scene unsaved-changes ledger (REQ-C-02). Godot 4.6 has no getter for a
## scene's unsaved state, so the addon tracks it: a mutation sets res_path->true,
## save clears it, get_open_scenes reports it.
var _dirty_scenes: Dictionary = {}


func _ready() -> void:
	_start_ms = Time.get_ticks_msec()
	var port := _configured_port()
	var err := _tcp.listen(port, "127.0.0.1")
	if err != OK:
		push_error("[godot-mcp] Failed to listen on 127.0.0.1:%d (error %d). Is another editor already bridging this port?" % [port, err])
		return
	print("[godot-mcp] Bridge listening on ws://127.0.0.1:%d" % port)


## Reads godot_mcp/network/port, falling back to DEFAULT_PORT on out-of-range
## or non-numeric values (mirrors the TS side's lenient readBridgePort).
func _configured_port() -> int:
	if not ProjectSettings.has_setting(PORT_SETTING):
		return DEFAULT_PORT
	var raw: Variant = ProjectSettings.get_setting(PORT_SETTING)
	var port := int(raw)
	if port < 1 or port > 65535:
		push_warning("[godot-mcp] Ignoring invalid %s value %s; using default port %d." % [PORT_SETTING, str(raw), DEFAULT_PORT])
		return DEFAULT_PORT
	return port


func _exit_tree() -> void:
	if _peer != null:
		_peer.close()
	_tcp.stop()


func _process(_delta: float) -> void:
	_accept_pending()
	if _peer == null:
		return
	_peer.poll()
	var state := _peer.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		if not _hello_sent:
			_send_json(_hello())
			_hello_sent = true
		while _peer.get_available_packet_count() > 0:
			_receive(_peer.get_packet().get_string_from_utf8())
		_drain_queue()
	elif state == WebSocketPeer.STATE_CLOSED:
		print("[godot-mcp] Bridge client disconnected (code %d)." % _peer.get_close_code())
		_reset_peer()


func _accept_pending() -> void:
	while _tcp.is_connection_available():
		var conn := _tcp.take_connection()
		if conn == null:
			continue
		if _peer != null:
			if _peer.get_ready_state() != WebSocketPeer.STATE_CLOSED:
				# Single-client policy (PRD #63 §7): drop the extra connection.
				push_warning("[godot-mcp] Refused a second concurrent bridge client.")
				conn.disconnect_from_host()
				continue
			# The old peer closed this frame, before _process's STATE_CLOSED
			# branch ran: drop its queued ops so the new client never executes
			# a dead client's requests (REQ-A-12 hazard once ops mutate).
			print("[godot-mcp] Bridge client disconnected (replaced by a new connection).")
			_reset_peer()
		var ws := WebSocketPeer.new()
		var err := ws.accept_stream(conn)
		if err != OK:
			push_warning("[godot-mcp] WebSocket accept failed (error %d)." % err)
			continue
		_peer = ws
		_hello_sent = false


func _reset_peer() -> void:
	_peer = null
	_hello_sent = false
	_queue.clear()


func _receive(text: String) -> void:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("[godot-mcp] Ignoring malformed (non-object) frame.")
		return
	var frame: Dictionary = parsed
	if str(frame.get("type", "")) == "hello_ack":
		print("[godot-mcp] MCP server connected: v%s (protocol %s)." % [
			str(frame.get("server_version", "?")),
			str(frame.get("protocol_version", "?")),
		])
		return
	if not frame.has("id") or not frame.has("method"):
		push_warning("[godot-mcp] Ignoring frame with no id/method.")
		return
	_queue.push_back(frame)


func _drain_queue() -> void:
	# Serialized execution, arrival order (REQ-A-12): one op per frame keeps
	# the editor responsive and makes op interleaving deterministic.
	if _queue.is_empty():
		return
	var frame: Dictionary = _queue.pop_front()
	var id: Variant = frame.get("id")
	var method := str(frame.get("method", ""))
	var params: Dictionary = {}
	if typeof(frame.get("params")) == TYPE_DICTIONARY:
		params = frame["params"]
	var outcome := _dispatch(method, params)
	if outcome.has("error"):
		_send_json({"id": id, "error": outcome["error"]})
	else:
		_send_json({"id": id, "result": outcome.get("result")})


## Named-op dispatch table (REQ-M-03: only named ops exist - there is no
## eval/exec pathway). Later slices append branches here via ops/*.gd.
func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"system/status":
			return {"result": _status()}
		"project/info":
			return {"result": _op_project_info()}
		"project/list_resources":
			return {"result": _op_list_resources(params)}
		"assets/import":
			return {"result": _op_import_assets(params)}
		"scene/create":
			return _op_scene_create(params)
		"scene/open":
			return _op_scene_open(params)
		"scene/list_open":
			return _op_scene_list_open()
		"scene/mark_unsaved":
			return _op_scene_mark_unsaved()
		"scene/save":
			return _op_scene_save(params)
		"scene/close":
			return _op_scene_close(params)
		"node/add":
			return _op_node_add(params)
		"edit/undo":
			return _op_edit_undo()
		"edit/redo":
			return _op_edit_redo()
		_:
			return {"error": {
				"code": "unknown_method",
				"message": "Unknown bridge method: %s" % method,
				"possibleSolutions": [
					"Update the Godot MCP addon in this project to match the MCP server version.",
					"Call bridge_status and compare addon_version and server_version.",
				],
			}}


func _hello() -> Dictionary:
	var v := Engine.get_version_info()
	return {
		"type": "hello",
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": _addon_version(),
		"godot_version": {
			"major": int(v.get("major", 0)),
			"minor": int(v.get("minor", 0)),
			"patch": int(v.get("patch", 0)),
			"status": str(v.get("status", "unknown")),
		},
		"godot_version_string": "%d.%d.%d.%s" % [
			int(v.get("major", 0)), int(v.get("minor", 0)), int(v.get("patch", 0)), str(v.get("status", "unknown")),
		],
		"features": {"dotnet": ClassDB.class_exists("CSharpScript")},
		"project_path": ProjectSettings.globalize_path("res://"),
	}


func _status() -> Dictionary:
	var hello := _hello()
	return {
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": hello["addon_version"],
		"godot_version": hello["godot_version"],
		"godot_version_string": hello["godot_version_string"],
		"features": hello["features"],
		"project_path": hello["project_path"],
		"uptime_ms": Time.get_ticks_msec() - _start_ms,
		"queue_depth": _queue.size(),
	}


## Project metadata read from the live editor (REQ-B-02): name/main scene/
## autoloads from ProjectSettings, versions from the engine, file tallies from
## the editor's resource filesystem.
func _op_project_info() -> Dictionary:
	var hello := _hello()
	var tally := {"total": 0, "scenes": 0, "scripts": 0}
	_count_files(EditorInterface.get_resource_filesystem().get_filesystem(), tally)
	var total := int(tally["total"])
	var scenes := int(tally["scenes"])
	var scripts := int(tally["scripts"])
	return {
		"name": str(ProjectSettings.get_setting("application/config/name", "")),
		"main_scene": str(ProjectSettings.get_setting("application/run/main_scene", "")),
		"features": _project_features(),
		"godot_version": hello["godot_version"],
		"godot_version_string": hello["godot_version_string"],
		"autoloads": _project_autoloads(),
		"file_counts": {
			"total": total,
			"scenes": scenes,
			"scripts": scripts,
			"resources": total - scenes - scripts,
		},
	}


## application/config/features as a plain Array[String].
func _project_features() -> Array:
	var raw: Variant = ProjectSettings.get_setting("application/config/features", PackedStringArray())
	var out: Array = []
	if raw is PackedStringArray:
		for feature in raw:
			out.append(str(feature))
	return out


## [{name, path}] for every autoload/* project setting, stripping the leading
## "*" that marks a singleton-enabled autoload.
func _project_autoloads() -> Array:
	var out: Array = []
	for prop in ProjectSettings.get_property_list():
		var pname := str(prop.get("name", ""))
		if not pname.begins_with("autoload/"):
			continue
		var auto_name := pname.substr("autoload/".length())
		var value := str(ProjectSettings.get_setting(pname, ""))
		if value.begins_with("*"):
			value = value.substr(1)
		out.append({"name": auto_name, "path": value})
	return out


## Recursively tallies total files plus scene/script counts across the editor's
## resource filesystem tree.
func _count_files(dir: EditorFileSystemDirectory, tally: Dictionary) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		tally["total"] = int(tally["total"]) + 1
		var file_type := str(dir.get_file_type(i))
		if file_type == "PackedScene":
			tally["scenes"] = int(tally["scenes"]) + 1
		elif file_type == "GDScript" or file_type == "CSharpScript":
			tally["scripts"] = int(tally["scripts"]) + 1
	for i in dir.get_subdir_count():
		_count_files(dir.get_subdir(i), tally)


## Flat resource listing from the editor's filesystem (REQ-B-05): every file's
## res:// path + resource type, plus its UID text when it has one. Optional
## `type` and `directory` (res:// prefix) filters narrow the result.
func _op_list_resources(params: Dictionary) -> Dictionary:
	var filter_type := str(params.get("type", ""))
	var filter_dir := str(params.get("directory", ""))
	var out: Array = []
	_collect_resources(EditorInterface.get_resource_filesystem().get_filesystem(), filter_type, filter_dir, out)
	return {"resources": out, "count": out.size()}


func _collect_resources(dir: EditorFileSystemDirectory, filter_type: String, filter_dir: String, out: Array) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		var res_path := dir.get_file_path(i)
		var res_type := str(dir.get_file_type(i))
		if filter_type != "" and res_type != filter_type:
			continue
		if filter_dir != "" and not _under_dir(res_path, filter_dir):
			continue
		var entry := {"path": res_path, "type": res_type}
		var uid_id := ResourceLoader.get_resource_uid(res_path)
		if uid_id != ResourceUID.INVALID_ID:
			entry["uid"] = ResourceUID.id_to_text(uid_id)
		out.append(entry)
	for i in dir.get_subdir_count():
		_collect_resources(dir.get_subdir(i), filter_type, filter_dir, out)


## True when `res_path` is `prefix` itself or lives directly under it — avoids
## the sibling-prefix false match ("res://scenes" vs "res://scenes2/x").
func _under_dir(res_path: String, prefix: String) -> bool:
	var normalized := prefix.trim_suffix("/")
	return res_path == normalized or res_path.begins_with(normalized + "/")


## Editor-native scan/reimport (REQ-J-01) — the successor to headless --import.
## With explicit `paths`: register each file with the resource filesystem
## (update_file) then reimport them synchronously, so a just-dropped file is a
## usable res:// resource on return. With no paths: kick off an async
## whole-project rescan (progress frames arrive in a later slice, #75). The
## PRODUCT never spawns Godot (REQ-A-01) — this runs inside the live editor.
func _op_import_assets(params: Dictionary) -> Dictionary:
	var fs := EditorInterface.get_resource_filesystem()
	var raw: Variant = params.get("paths", [])
	var paths := PackedStringArray()
	if raw is Array:
		for entry in raw:
			paths.append(str(entry))
	if paths.is_empty():
		fs.scan()
		return {"scan_started": true, "reimported": []}
	for res_path in paths:
		fs.update_file(res_path)
	fs.reimport_files(paths)
	var reimported: Array = []
	for res_path in paths:
		reimported.append(res_path)
	return {"scan_started": false, "reimported": reimported}


## Structured op-error outcome (mirrors the TS BridgeOpError shape). Ops return
## this instead of {"result": ...} to make the bridge client reject with guidance.
func _err(code: String, message: String, solutions: Array) -> Dictionary:
	return {"error": {"code": code, "message": message, "possibleSolutions": solutions}}


## Addon-side containment (REQ-M-01, defense-in-depth): the server already
## normalized this to a canonical res:// path, so we only re-reject a residual
## "res://" prefix miss or a ".." segment. Returns the res:// path or "" on reject.
func _scene_res_path(raw: String) -> String:
	if not raw.begins_with("res://"):
		return ""
	if "/../" in raw or raw.ends_with("/.."):
		return ""
	return raw


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


## res:// path of the current edited scene, or "" if none / an unsaved new scene.
func _current_scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return ""
	return root.scene_file_path


## Open scene tabs with their dirty flags + which is current (REQ-C-02/C-03).
func _op_scene_list_open() -> Dictionary:
	var current := _current_scene_path()
	var scenes: Array = []
	for p in EditorInterface.get_open_scenes():
		var res_p := str(p)
		scenes.append({"path": res_p, "dirty": bool(_dirty_scenes.get(res_p, false))})
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
	_dirty_scenes[current] = true
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
			_dirty_scenes.erase(res_all)
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
		_dirty_scenes.erase(current)
		_dirty_scenes.erase(new_path)
		return {"result": {"saved": [new_path], "current": new_path, "all": false}}

	var err := EditorInterface.save_scene()
	if err != OK:
		return _err("save_failed", "Failed to save %s (error %d)." % [current, err], [
			"Check that the scene's file is writable.",
		])
	_dirty_scenes.erase(current)
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
	if bool(_dirty_scenes.get(target, false)) and not discard:
		return _err("unsaved_changes", "%s has unsaved changes." % target, [
			"Save it with save_scene first, or pass discard:true to close and lose the changes.",
		])
	if _current_scene_path() != target:
		EditorInterface.open_scene_from_path(target)
	EditorInterface.close_scene()
	_dirty_scenes.erase(target)
	var current := _current_scene_path()
	return {"result": {"scene_path": target, "closed": true, "current": current if current != "" else null}}


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
	_dirty_scenes[scene_root.scene_file_path] = true
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


func _addon_version() -> String:
	var cfg := ConfigFile.new()
	if cfg.load("res://addons/godot_mcp/plugin.cfg") == OK:
		return str(cfg.get_value("plugin", "version", "unknown"))
	return "unknown"


func _send_json(data: Dictionary) -> void:
	if _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_peer.send_text(JSON.stringify(data))
