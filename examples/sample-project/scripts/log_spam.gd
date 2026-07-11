extends Node

## Infinite log-spam fixture for #72's REQ-E-03 boundedness test: prints
## LINES_PER_FRAME numbered lines every process frame and never quits, so
## the run-output ring buffer must keep evicting under sustained spam until
## stop_project ends the session.

const LINES_PER_FRAME := 200

var _counter := 0


func _process(_delta: float) -> void:
	for _i in LINES_PER_FRAME:
		_counter += 1
		print("GODOT_MCP_SPAM line %d" % _counter)
