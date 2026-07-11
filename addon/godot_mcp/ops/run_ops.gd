@tool
extends "op_base.gd"

## Run-control op handlers (#72): play main/current/named scene through the
## editor's own play machinery (REQ-E-01), stop (REQ-E-02), and cursor-read
## the captured session output (REQ-E-03). The ring buffer itself lives on
## server.run_log (fed by debugger_capture.gd); these ops only drive
## EditorInterface and read the buffer. Every condition that would make the
## editor pop a modal dialog (no main scene, never-saved current scene) is
## a guided error instead - a modal would hang an unattended session.


## run/play: starts a session. An already-running session is stopped first
## and reported as replaced_active (1.0's replace semantics). The buffer is
## cleared so output belongs to exactly one session, re-armed with the
## server-supplied buffer_lines (OUTPUT_BUFFER_LINES).
func _op_run_play(params: Dictionary) -> Dictionary:
	var mode := str(params.get("mode", "main"))
	var scene_path := ""
	match mode:
		"main":
			scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
			if scene_path == "":
				return _err("no_main_scene", "This project has no main scene set (application/run/main_scene).", [
					"Play a specific scene instead: run_project with scene_path.",
					"Or set the main scene under Project Settings > Application > Run.",
				])
		"current":
			scene_path = _current_scene_path()
			if scene_path == "":
				if EditorInterface.get_edited_scene_root() == null:
					return _err("no_current_scene", "No scene is currently open in the editor.", [
						"Open one with open_scene, or pass scene_path to play a named scene.",
					])
				return _err("unsaved_current_scene", "The current scene has never been saved - the editor cannot play it.", [
					"Save it first with save_scene, then retry.",
				])
		"custom":
			scene_path = _scene_res_path(str(params.get("scene_path", "")))
			if scene_path == "":
				return _err("path_escape", "scene_path is not a valid in-project res:// path.", [
					"Pass a res:// path with no '..' segments.",
				])
			if not FileAccess.file_exists(scene_path):
				return _err("scene_not_found", "No scene exists at %s." % scene_path, [
					"Check the path with list_resources, or create it with create_scene.",
				])
		_:
			return _err("invalid_mode", "Unknown play mode '%s'." % mode, [
				"Use mode main, current, or custom.",
			])
	var replaced := EditorInterface.is_playing_scene()
	if replaced:
		EditorInterface.stop_playing_scene()
	if server.run_log != null:
		server.run_log.reset(int(params.get("buffer_lines", 0)))
	match mode:
		"main":
			EditorInterface.play_main_scene()
		"current":
			EditorInterface.play_current_scene()
		"custom":
			EditorInterface.play_custom_scene(scene_path)
	return {"result": {"mode": mode, "scene_path": scene_path, "replaced_active": replaced}}
