extends Node2D

# Minimal valid script for the sample project. Integration tests run the
# project headless and assert get_debug_output captures this line.
func _ready() -> void:
	print("godot-mcp sample: ready")
	# Quit immediately so headless runs terminate on their own.
	get_tree().quit()
