@tool
extends EditorPlugin

## Entry point of the Godot MCP addon (REQ-A-01): owns the bridge server's
## lifecycle, the run-output debugger capture (#72), and the GodotMCPRuntime
## autoload that forwards game output. All logging goes to the editor Output
## panel (REQ-A-09/M-07).

const BRIDGE_SERVER_SCRIPT := preload("res://addons/godot_mcp/server.gd")
const DEBUGGER_CAPTURE_SCRIPT := preload("res://addons/godot_mcp/debugger_capture.gd")
const RUNTIME_AUTOLOAD_NAME := "GodotMCPRuntime"
const RUNTIME_AUTOLOAD_PATH := "res://addons/godot_mcp/runtime/log_capture.gd"

var _server: Node = null
var _debugger: EditorDebuggerPlugin = null


func _enter_tree() -> void:
	_debugger = DEBUGGER_CAPTURE_SCRIPT.new()
	add_debugger_plugin(_debugger)
	# Self-heal: _enable_plugin() only fires on the Plugins-UI toggle, never
	# on editor boot - projects that enabled the plugin before the autoload
	# existed (and fixtures that pre-enable it in project.godot) get the
	# autoload registered here instead. This MUST complete - including the
	# explicit save - before the bridge starts accepting ops: spawned games
	# read project.godot from disk, and the editor's own save after
	# add_autoload_singleton is debounced (~1.5s), so a run_project arriving
	# inside that window would boot a game without the forwarding autoload
	# and silently lose the whole session's output (#96).
	_ensure_runtime_autoload()
	_server = BRIDGE_SERVER_SCRIPT.new()
	_server.name = "GodotMcpBridgeServer"
	_server.run_log = _debugger.run_log
	add_child(_server)


func _exit_tree() -> void:
	if _debugger != null:
		remove_debugger_plugin(_debugger)
		_debugger = null
	if _server != null:
		_server.queue_free()
		_server = null


func _enable_plugin() -> void:
	_ensure_runtime_autoload()


func _ensure_runtime_autoload() -> void:
	if ProjectSettings.has_setting("autoload/" + RUNTIME_AUTOLOAD_NAME):
		return
	add_autoload_singleton(RUNTIME_AUTOLOAD_NAME, RUNTIME_AUTOLOAD_PATH)
	ProjectSettings.save()


func _disable_plugin() -> void:
	if ProjectSettings.has_setting("autoload/" + RUNTIME_AUTOLOAD_NAME):
		remove_autoload_singleton(RUNTIME_AUTOLOAD_NAME)
