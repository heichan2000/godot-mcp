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
const DEFERRED_TIMEOUT_SETTING := "godot_mcp/network/deferred_op_timeout_ms"
const DEFAULT_DEFERRED_TIMEOUT_MS := 300_000

var _tcp := TCPServer.new()
var _peer: WebSocketPeer = null
var _hello_sent := false
var _queue: Array[Dictionary] = []
var _start_ms := 0

## Per-scene unsaved-changes ledger (REQ-C-02). Godot 4.6 has no getter for a
## scene's unsaved state, so the addon tracks it: a mutation sets res_path->true,
## save clears it, get_open_scenes reports it.
var _dirty_scenes: Dictionary = {}

## The one deferred (multi-frame) op currently executing: {id, task} or empty.
## While non-empty the queue does not drain, so serialization (REQ-A-12) holds
## for deferred ops exactly as for synchronous ones.
var _inflight: Dictionary = {}

## Run-output ring log (REQ-E-03), owned by the debugger-capture plugin and
## injected by plugin.gd before add_child so run ops can read it.
var run_log: RefCounted = null

const ProjectOps := preload("ops/project_ops.gd")
const SceneOps := preload("ops/scene_ops.gd")
const NodeOps := preload("ops/node_ops.gd")
const PropertyOps := preload("ops/property_ops.gd")
const RunOps := preload("ops/run_ops.gd")
const MeshLibraryOps := preload("ops/mesh_library_ops.gd")

var _project_ops: RefCounted = null
var _scene_ops: RefCounted = null
var _node_ops: RefCounted = null
var _property_ops: RefCounted = null
var _run_ops: RefCounted = null
var _mesh_library_ops: RefCounted = null


func _ready() -> void:
	_project_ops = ProjectOps.new(self)
	_scene_ops = SceneOps.new(self)
	_node_ops = NodeOps.new(self)
	_property_ops = PropertyOps.new(self)
	_run_ops = RunOps.new(self)
	_mesh_library_ops = MeshLibraryOps.new(self)
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


## Reads godot_mcp/network/deferred_op_timeout_ms - the wall-clock cap (#95)
## on how long one deferred op may hold the queue - falling back to the
## default on non-numeric or non-positive values (mirrors _configured_port).
func _deferred_op_timeout_ms() -> int:
	if not ProjectSettings.has_setting(DEFERRED_TIMEOUT_SETTING):
		return DEFAULT_DEFERRED_TIMEOUT_MS
	var raw: Variant = ProjectSettings.get_setting(DEFERRED_TIMEOUT_SETTING)
	var timeout_ms := int(raw)
	if timeout_ms < 1:
		push_warning("[godot-mcp] Ignoring invalid %s value %s; using default %d ms." % [DEFERRED_TIMEOUT_SETTING, str(raw), DEFAULT_DEFERRED_TIMEOUT_MS])
		return DEFAULT_DEFERRED_TIMEOUT_MS
	return timeout_ms


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
		_tick_inflight()
		if _inflight.is_empty():
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
	_inflight = {}


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
	var outcome := _dispatch(method, params, id)
	if outcome.has("task"):
		# Deferred op (REQ-A-11): hold the queue and tick it each frame. The
		# wall-clock cap (#95) is stamped now so _tick_inflight can always
		# free the slot - progress re-arms the CLIENT's deadline, so without
		# this cap a task that never completes would wedge the bridge forever.
		var cap_ms := _deferred_op_timeout_ms()
		_inflight = {
			"id": id,
			"task": outcome["task"],
			"cap_ms": cap_ms,
			"deadline_ms": Time.get_ticks_msec() + cap_ms,
		}
	elif outcome.has("error"):
		_send_json({"id": id, "error": outcome["error"]})
	else:
		_send_json({"id": id, "result": outcome.get("result")})


## Sends a progress frame (REQ-A-11) for an in-flight op, then polls the peer
## so the frame hits the wire immediately - WebSocketPeer buffers outgoing
## data until poll(), and a blocking op would otherwise deliver all its
## progress AFTER the response, defeating the client's deadline extension.
func emit_progress(id: Variant, payload: Dictionary) -> void:
	if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	_peer.send_text(JSON.stringify({"id": id, "progress": payload}))
	_peer.poll()


## Ticks the in-flight deferred op, if any. tick() returns null while still
## running (it may have emitted progress) or a {result}/{error} outcome dict.
## The wall-clock cap (#95) is checked BEFORE ticking: on expiry the task is
## abandoned (dropped - any underlying editor scan continues harmlessly, and
## no late frames can leak since only the armed task emits progress for its
## id), a structured error is sent, and the queue resumes draining this same
## frame (REQ-A-12). The outcome guard keeps a future task's malformed tick()
## return from crashing the queue.
func _tick_inflight() -> void:
	if _inflight.is_empty():
		return
	var id: Variant = _inflight["id"]
	if Time.get_ticks_msec() >= int(_inflight["deadline_ms"]):
		var cap_ms := int(_inflight["cap_ms"])
		_inflight = {}
		_send_json({"id": id, "error": {
			"code": "deferred_op_timeout",
			"message": "Deferred op exceeded the %d ms wall-clock cap and was abandoned." % cap_ms,
			"possibleSolutions": [
				"Raise godot_mcp/network/deferred_op_timeout_ms in project settings if this op legitimately needs longer.",
				"Check the editor for a stuck filesystem scan.",
			],
		}})
		return
	var task: RefCounted = _inflight["task"]
	var outcome: Variant = task.call("tick")
	if outcome == null:
		return
	_inflight = {}
	if not (outcome is Dictionary):
		_send_json({"id": id, "error": {
			"code": "internal_error",
			"message": "Deferred task returned a malformed outcome (%s)." % type_string(typeof(outcome)),
			"possibleSolutions": [
				"This is an addon bug - report it with the op name and editor log.",
			],
		}})
		return
	var outcome_dict: Dictionary = outcome
	if outcome_dict.has("error"):
		_send_json({"id": id, "error": outcome_dict["error"]})
	else:
		_send_json({"id": id, "result": outcome_dict.get("result")})


## Named-op dispatch table (REQ-M-03: only named ops exist - there is no
## eval/exec pathway). Later slices append branches here via ops/*.gd.
func _dispatch(method: String, params: Dictionary, id: Variant) -> Dictionary:
	match method:
		"system/status":
			return {"result": _status()}
		"project/info":
			return {"result": _project_ops._op_project_info()}
		"project/list_resources":
			return {"result": _project_ops._op_list_resources(params)}
		"assets/import":
			return _project_ops._op_import_assets(params, id)
		"uid/get":
			return _project_ops._op_get_uid(params)
		"uid/update_project":
			return _project_ops._op_update_project_uids()
		"scene/create":
			return _scene_ops._op_scene_create(params)
		"scene/open":
			return _scene_ops._op_scene_open(params)
		"scene/list_open":
			return _scene_ops._op_scene_list_open()
		"scene/mark_unsaved":
			return _scene_ops._op_scene_mark_unsaved()
		"scene/save":
			return _scene_ops._op_scene_save(params)
		"scene/close":
			return _scene_ops._op_scene_close(params)
		"scene/get_tree":
			return _scene_ops._op_scene_get_tree()
		"scene/export_mesh_library":
			return _mesh_library_ops._op_export_mesh_library(params, id)
		"node/add":
			return _node_ops._op_node_add(params)
		"node/remove":
			return _node_ops._op_node_remove(params)
		"node/duplicate":
			return _node_ops._op_node_duplicate(params)
		"node/move":
			return _node_ops._op_node_move(params)
		"node/rename":
			return _node_ops._op_node_rename(params)
		"node/get_properties":
			return _property_ops._op_get_properties(params)
		"node/set_properties":
			return _property_ops._op_set_properties(params)
		"edit/undo":
			return _node_ops._op_edit_undo()
		"edit/redo":
			return _node_ops._op_edit_redo()
		"run/play":
			return _run_ops._op_run_play(params)
		"run/stop":
			return _run_ops._op_run_stop()
		"run/get_output":
			return _run_ops._op_run_get_output(params)
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


func _addon_version() -> String:
	var cfg := ConfigFile.new()
	if cfg.load("res://addons/godot_mcp/plugin.cfg") == OK:
		return str(cfg.get_value("plugin", "version", "unknown"))
	return "unknown"


func _send_json(data: Dictionary) -> void:
	if _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_peer.send_text(JSON.stringify(data))
