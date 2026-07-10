@tool
extends RefCounted

## Shared base for bridge op handlers (split out of server.gd in #70).
## Holds the server back-reference (the _dirty_scenes ledger lives on the
## server node) and the helpers every ops file uses.

var server: Node


func _init(srv: Node) -> void:
	server = srv


## Structured op-error outcome (mirrors the TS BridgeOpError shape). Ops return
## this instead of {"result": ...} to make the bridge client reject with guidance.
func _err(code: String, message: String, solutions: Array) -> Dictionary:
	return {"error": {"code": code, "message": message, "possibleSolutions": solutions}}


## Addon-side containment (REQ-M-01, defense-in-depth): the server already
## normalized this to a canonical res:// path, so we only re-reject a residual
## "res://" prefix miss or a ".." segment. Returns the res:// path or "" on reject.
func _scene_res_path(raw: String) -> String:
	if not raw.begins_with("res://"):
		return ""
	if "/../" in raw or raw.ends_with("/.."):
		return ""
	return raw


## res:// path of the current edited scene, or "" if none / an unsaved new scene.
func _current_scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return ""
	return root.scene_file_path
