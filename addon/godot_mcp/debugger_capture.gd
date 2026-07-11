@tool
extends EditorDebuggerPlugin

## Editor-side half of the run-output channel (REQ-E-03): receives the
## godot_mcp:log messages the game-side autoload (runtime/log_capture.gd)
## forwards over the editor debugger connection and appends them to the
## bounded run log. A dedicated prefixed channel is required: the engine's
## own "output" debugger frames are core messages the editor consumes
## internally - EditorDebuggerPlugin._capture() never sees them. This
## channel is deliberately the seed of the M2 runtime log loop.

const RunLog := preload("run_log.gd")

var run_log: RefCounted = RunLog.new()


func _has_capture(capture: String) -> bool:
	return capture == "godot_mcp"


func _capture(message: String, data: Array, _session_id: int) -> bool:
	if message != "godot_mcp:log":
		return false
	if data.size() >= 2:
		run_log.push(str(data[0]), str(data[1]))
	return true
