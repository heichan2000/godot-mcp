@tool
extends "op_base.gd"

## Project op handlers, split out of server.gd (#70). Bodies are
## verbatim moves; shared helpers live in op_base.gd, shared state on server.

const DeferredScanTask := preload("deferred_scan_task.gd")


## Project metadata read from the live editor (REQ-B-02): name/main scene/
## autoloads from ProjectSettings, versions from the engine, file tallies from
## the editor's resource filesystem.
func _op_project_info() -> Dictionary:
	var hello: Dictionary = server._hello()
	var tally := {"total": 0, "scenes": 0, "scripts": 0}
	_count_files(EditorInterface.get_resource_filesystem().get_filesystem(), tally)
	var total := int(tally["total"])
	var scenes := int(tally["scenes"])
	var scripts := int(tally["scripts"])
	return {
		"name": str(ProjectSettings.get_setting("application/config/name", "")),
		"main_scene": str(ProjectSettings.get_setting("application/run/main_scene", "")),
		"features": _project_features(),
		"godot_version": hello["godot_version"],
		"godot_version_string": hello["godot_version_string"],
		"autoloads": _project_autoloads(),
		"file_counts": {
			"total": total,
			"scenes": scenes,
			"scripts": scripts,
			"resources": total - scenes - scripts,
		},
	}


## application/config/features as a plain Array[String].
func _project_features() -> Array:
	var raw: Variant = ProjectSettings.get_setting("application/config/features", PackedStringArray())
	var out: Array = []
	if raw is PackedStringArray:
		for feature in raw:
			out.append(str(feature))
	return out


## [{name, path}] for every autoload/* project setting, stripping the leading
## "*" that marks a singleton-enabled autoload.
func _project_autoloads() -> Array:
	var out: Array = []
	for prop in ProjectSettings.get_property_list():
		var pname := str(prop.get("name", ""))
		if not pname.begins_with("autoload/"):
			continue
		var auto_name := pname.substr("autoload/".length())
		var value := str(ProjectSettings.get_setting(pname, ""))
		if value.begins_with("*"):
			value = value.substr(1)
		out.append({"name": auto_name, "path": value})
	return out


## Recursively tallies total files plus scene/script counts across the editor's
## resource filesystem tree.
func _count_files(dir: EditorFileSystemDirectory, tally: Dictionary) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		tally["total"] = int(tally["total"]) + 1
		var file_type := str(dir.get_file_type(i))
		if file_type == "PackedScene":
			tally["scenes"] = int(tally["scenes"]) + 1
		elif file_type == "GDScript" or file_type == "CSharpScript":
			tally["scripts"] = int(tally["scripts"]) + 1
	for i in dir.get_subdir_count():
		_count_files(dir.get_subdir(i), tally)


## Flat resource listing from the editor's filesystem (REQ-B-05): every file's
## res:// path + resource type, plus its UID text when it has one. Optional
## `type` and `directory` (res:// prefix) filters narrow the result.
func _op_list_resources(params: Dictionary) -> Dictionary:
	var filter_type := str(params.get("type", ""))
	var filter_dir := str(params.get("directory", ""))
	if filter_dir != "":
		# Addon-side containment (REQ-M-01, #76): the filter is a res:// prefix.
		filter_dir = _scene_res_path(filter_dir)
		if filter_dir == "":
			return _err("path_escape", "directory is not a valid in-project res:// path.", [
				"Pass a res:// directory inside the project, with no .. segments.",
			])
	var out: Array = []
	_collect_resources(EditorInterface.get_resource_filesystem().get_filesystem(), filter_type, filter_dir, out)
	return {"result": {"resources": out, "count": out.size()}}


func _collect_resources(dir: EditorFileSystemDirectory, filter_type: String, filter_dir: String, out: Array) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		var res_path := dir.get_file_path(i)
		var res_type := str(dir.get_file_type(i))
		if filter_type != "" and res_type != filter_type:
			continue
		if filter_dir != "" and not _under_dir(res_path, filter_dir):
			continue
		var entry := {"path": res_path, "type": res_type}
		var uid_id := ResourceLoader.get_resource_uid(res_path)
		if uid_id != ResourceUID.INVALID_ID:
			entry["uid"] = ResourceUID.id_to_text(uid_id)
		out.append(entry)
	for i in dir.get_subdir_count():
		_collect_resources(dir.get_subdir(i), filter_type, filter_dir, out)


## True when `res_path` is `prefix` itself or lives directly under it — avoids
## the sibling-prefix false match ("res://scenes" vs "res://scenes2/x").
func _under_dir(res_path: String, prefix: String) -> bool:
	var normalized := prefix.trim_suffix("/")
	return res_path == normalized or res_path.begins_with(normalized + "/")


## Editor-native scan/reimport (REQ-J-01) with progress frames (REQ-A-11).
## With explicit `paths`: register + reimport the files one at a time, emitting
## a reimport progress frame before each so big batches keep extending the
## client's deadline. With no paths: kick off an async whole-project rescan and
## defer the response via DeferredScanTask - the client's reply arrives only when the
## editor finishes scanning. The PRODUCT never spawns Godot (REQ-A-01).
## Returns a full outcome dict ({"result"} or {"task"}), not a bare result.
func _op_import_assets(params: Dictionary, id: Variant) -> Dictionary:
	var fs := EditorInterface.get_resource_filesystem()
	var raw: Variant = params.get("paths", [])
	var paths := PackedStringArray()
	if raw is Array:
		for entry in raw:
			# Addon-side containment (REQ-M-01, #76): reject the whole batch on
			# the first escaping entry - never partially import.
			var res_path := _scene_res_path(str(entry))
			if res_path == "":
				return _err("path_escape", "paths must be res:// paths inside the project.", [
					"Pass res:// paths inside the project, with no .. segments.",
				])
			paths.append(res_path)
	if paths.is_empty():
		fs.scan()
		return {"task": DeferredScanTask.new(server, id, fs, "scan", {
			"scan_started": true, "scan_completed": true, "reimported": [],
		})}
	var total := paths.size()
	var reimported: Array = []
	for i in total:
		var res_path := paths[i]
		server.emit_progress(id, {
			"stage": "reimport", "current": i, "total": total, "message": res_path,
		})
		fs.update_file(res_path)
		fs.reimport_files(PackedStringArray([res_path]))
		reimported.append(res_path)
	return {"result": {"scan_started": false, "reimported": reimported}}


## Resource UID lookup (REQ-B-08): the uid:// text for a res:// path, read
## from the editor's UID registry. A text resource authored without a uid=
## header has no registered UID until update_project_uids resaves it - that
## case is a guided no_uid error, exactly 1.0's contract.
func _op_get_uid(params: Dictionary) -> Dictionary:
	# Addon-side containment (REQ-M-01, #76): reject before ANY FileAccess call -
	# an uncontained absolute path would probe the host filesystem's existence.
	var res_path := _scene_res_path(str(params.get("path", "")))
	if res_path == "":
		return _err("path_escape", "path is not a valid in-project res:// path.", [
			"Pass a res:// path inside the project, with no .. segments.",
		])
	if not FileAccess.file_exists(res_path):
		return {"error": {
			"code": "file_not_found",
			"message": "No file exists at %s." % res_path,
			"possibleSolutions": [
				"Check the path with list_resources - it must name an existing res:// file.",
			],
		}}
	var uid_id := ResourceLoader.get_resource_uid(res_path)
	if uid_id == ResourceUID.INVALID_ID:
		return {"error": {
			"code": "no_uid",
			"message": "No UID is assigned to the resource at %s yet." % res_path,
			"possibleSolutions": [
				"Run update_project_uids to resave UID-less resources, then retry.",
			],
		}}
	return {"result": {"path": res_path, "uid": ResourceUID.id_to_text(uid_id)}}


## Editor-native UID refresh (REQ-B-09): every text scene/resource
## (.tscn/.tres) with no registered UID is loaded and resaved INSIDE the
## editor - unlike 1.0's headless path, an editor-process ResourceSaver.save
## embeds a fresh uid= into the text header. update_file() then feeds each
## rewrite into the editor's UID registry so the very next uid/get sees it.
## Files already carrying a UID are never rewritten (no diff churn). Note:
## the resave works from the on-disk copy - unsaved editor changes to a
## UID-less scene are not captured (and per-file failures never block the
## rest of the walk; they land in `failed`).
func _op_update_project_uids() -> Dictionary:
	var candidates: Array = []
	_collect_uid_candidates(EditorInterface.get_resource_filesystem().get_filesystem(), candidates)
	var fs := EditorInterface.get_resource_filesystem()
	var touched: Array = []
	var already_had_uid: Array = []
	var failed: Array = []
	for res_path in candidates:
		if ResourceLoader.get_resource_uid(res_path) != ResourceUID.INVALID_ID:
			already_had_uid.append(res_path)
			continue
		var res: Resource = ResourceLoader.load(res_path)
		if res == null:
			failed.append({"path": res_path, "reason": "failed to load"})
			continue
		var err := ResourceSaver.save(res, res_path)
		if err != OK:
			failed.append({"path": res_path, "reason": "ResourceSaver.save failed (error %d)" % err})
			continue
		fs.update_file(res_path)
		if ResourceLoader.get_resource_uid(res_path) == ResourceUID.INVALID_ID:
			failed.append({"path": res_path, "reason": "resave did not register a UID"})
			continue
		touched.append(res_path)
	return {"result": {
		"touched": touched,
		"already_had_uid": already_had_uid,
		"failed": failed,
	}}


## Collects every .tscn/.tres res:// path in the editor's resource
## filesystem tree (the REQ-B-09 scope - scripts get .uid sidecars from the
## editor's own scan and are not managed here).
func _collect_uid_candidates(dir: EditorFileSystemDirectory, out: Array) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		var res_path := dir.get_file_path(i)
		var ext := res_path.get_extension().to_lower()
		if ext == "tscn" or ext == "tres":
			out.append(res_path)
	for i in dir.get_subdir_count():
		_collect_uid_candidates(dir.get_subdir(i), out)
