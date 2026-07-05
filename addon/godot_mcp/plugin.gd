@tool
extends EditorPlugin

## Entry point of the Godot MCP addon (REQ-A-01): owns the bridge server's
## lifecycle. All logging goes to the editor Output panel (REQ-A-09/M-07).

const BRIDGE_SERVER_SCRIPT := preload("res://addons/godot_mcp/server.gd")

var _server: Node = null


func _enter_tree() -> void:
	_server = BRIDGE_SERVER_SCRIPT.new()
	_server.name = "GodotMcpBridgeServer"
	add_child(_server)


func _exit_tree() -> void:
	if _server != null:
		_server.queue_free()
		_server = null
