@tool
extends RefCounted

## Shared deferred-task body (#95) for ops that kick EditorFileSystem.scan()
## and must not reply until it finishes (REQ-A-11): project_ops' bare
## import_assets (stage "scan") and mesh_library_ops' brand-new-directory
## export registration (stage "register"). server._tick_inflight calls tick()
## once per editor frame: null = still waiting (throttled progress may have
## been emitted); a {result} dict = done, reply with the payload captured at
## construction.
##
## Scan-start gate: scan() is kicked before this task is armed, but the editor
## may not flip is_scanning() until a later frame - trusting an early false
## reading would complete before the scan indexed anything. A false reading is
## trusted only after the scan was observed running, or once GRACE_TICKS
## expire (a genuinely instant scan still answers promptly). If the flag flips
## later than the grace, behavior degrades to the pre-#95 early completion -
## never a hang; the server-side wall-clock cap bounds the worst case.

const GRACE_TICKS := 10

var _server: Node
var _id: Variant
var _fs: EditorFileSystem
var _stage: String
var _result: Dictionary
var _scan_observed := false
var _ticks := 0
var _last_percent := -1
var _frames_since_emit := 0


func _init(srv: Node, id: Variant, fs: EditorFileSystem, stage: String, result: Dictionary) -> void:
	_server = srv
	_id = id
	_fs = fs
	_stage = stage
	_result = result


func tick() -> Variant:
	_ticks += 1
	if _fs.is_scanning():
		_scan_observed = true
		var percent := int(_fs.get_scanning_progress() * 100.0)
		_frames_since_emit += 1
		# Throttle: emit on change, or every 30 frames as a heartbeat.
		if percent != _last_percent or _frames_since_emit >= 30:
			_server.emit_progress(_id, {"stage": _stage, "current": percent, "total": 100})
			_last_percent = percent
			_frames_since_emit = 0
		return null
	if _scan_observed or _ticks >= GRACE_TICKS:
		return {"result": _result}
	return null
