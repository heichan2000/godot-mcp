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


func _ready() -> void:
	_start_ms = Time.get_ticks_msec()
	var port := DEFAULT_PORT
	if ProjectSettings.has_setting(PORT_SETTING):
		port = int(ProjectSettings.get_setting(PORT_SETTING))
	var err := _tcp.listen(port, "127.0.0.1")
	if err != OK:
		push_error("[godot-mcp] Failed to listen on 127.0.0.1:%d (error %d). Is another editor already bridging this port?" % [port, err])
		return
	print("[godot-mcp] Bridge listening on ws://127.0.0.1:%d" % port)


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
		if _peer != null and _peer.get_ready_state() != WebSocketPeer.STATE_CLOSED:
			# Single-client policy (PRD #63 §7): drop the extra connection.
			push_warning("[godot-mcp] Refused a second concurrent bridge client.")
			conn.disconnect_from_host()
			continue
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
func _dispatch(method: String, _params: Dictionary) -> Dictionary:
	match method:
		"system/status":
			return {"result": _status()}
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
