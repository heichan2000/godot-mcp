extends Node

## Game-side half of the run-output channel (REQ-E-03). Registered as the
## GodotMCPRuntime autoload by plugin.gd. In an exported game, or any run
## without the editor debugger attached, _init() does nothing and the node
## is inert. When the editor plays the game, a custom Logger forwards every
## print/printerr line and every engine error to the editor over the
## debugger connection, where debugger_capture.gd buffers them for
## get_debug_output. Clamping bounds the per-message wire size.

class ForwardingLogger extends Logger:
	const MAX_LINE_CHARS := 4096

	## Loggers can be called from any thread, possibly concurrently; the
	## mutex serializes sends, and _sending guards against re-entrancy if a
	## send itself ever raises an engine error.
	var _mutex := Mutex.new()
	var _sending := false

	func _log_message(message: String, error: bool) -> void:
		_send("stderr" if error else "stdout", message)

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, _error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		var what := rationale if rationale != "" else code
		_send("error", "%s (%s:%d in %s)" % [what, file, line, function])

	func _send(stream: String, text: String) -> void:
		_mutex.lock()
		if _sending:
			_mutex.unlock()
			return
		_sending = true
		EngineDebugger.send_message("godot_mcp:log", [stream, text.strip_edges(false, true).left(MAX_LINE_CHARS)])
		_sending = false
		_mutex.unlock()


func _init() -> void:
	if EngineDebugger.is_active():
		OS.add_logger(ForwardingLogger.new())
