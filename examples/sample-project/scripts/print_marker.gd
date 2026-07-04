extends Node

## Minimal fixture used by the run_project integration test
## (test/integration/run-project.integration.test.ts): prints one known,
## greppable marker line to stdout on _ready(), then quits so a headless
## `godot --headless -d --path <project> res://scenes/print_marker.tscn`
## invocation exits on its own instead of needing to be killed.

func _ready() -> void:
	print("GODOT_MCP_RUN_MARKER: hello from run_project")
	get_tree().quit()
