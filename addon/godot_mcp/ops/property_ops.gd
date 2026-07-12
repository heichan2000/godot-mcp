@tool
extends "op_base.gd"

## Node property op handlers (#74, REQ-C-06): symmetric get/set through the
## 1.0 value codec against the LIVE edited scene. The codec is carried from
## 1.0's operations.gd: JSON primitives travel natively, every other Variant
## type as its var_to_str text form - the same syntax .tscn files use - and
## str_to_var can never construct a Resource or run code. One departure from
## 1.0: TYPE_NIL encodes as JSON null (not the string "null"), symmetric
## with the write-side rule that null clears Object-typed properties.


## node/get_properties: read a node's properties (REQ-C-06). Default mode
## returns the live non-default state - storage-flagged properties whose
## value differs from the class default, plus script variables - what makes
## this node THIS node, including unsaved edits. Named mode returns exactly
## the requested names, stored or not (1.0 read_node_properties parity).
func _op_get_properties(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to read properties from.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var node_path := str(params.get("node_path", ""))
	var node := _resolve_node(scene_root, node_path)
	if node == null:
		return _err("node_not_found", "No node exists at node_path '%s'." % node_path, [
			"Read the tree with get_scene_tree to see valid node paths.",
		])
	var entries := _property_entries(node)
	var out := {}
	if params.has("properties"):
		var names: Array = params.get("properties") if typeof(params.get("properties")) == TYPE_ARRAY else []
		for raw_name in names:
			var name := str(raw_name)
			if not entries.has(name):
				return _unknown_property(node, entries, name)
			out[name] = encode_property_value(node.get(name))
	else:
		for name in entries:
			var usage := int(entries[name].get("usage", 0))
			if usage & PROPERTY_USAGE_STORAGE == 0:
				continue
			var value: Variant = node.get(name)
			if usage & PROPERTY_USAGE_SCRIPT_VARIABLE != 0:
				out[name] = encode_property_value(value)
			elif value != ClassDB.class_get_property_default_value(node.get_class(), name):
				out[name] = encode_property_value(value)
	return {"result": {
		"node_path": str(scene_root.get_path_to(node)),
		"node_type": node.get_class(),
		"properties": out,
	}}


## name -> get_property_list() entry for every property the node exposes
## (built-in and script alike). One dict so existence checks and declared-
## type lookups share a single walk.
func _property_entries(node: Node) -> Dictionary:
	var entries := {}
	for entry in node.get_property_list():
		entries[str(entry["name"])] = entry
	return entries


## The structured unknown-property error (REQ-C-06 acceptance): the message
## lists the node's meaningful property names - storage-flagged or script
## variables - sorted, so an agent can self-correct without a docs lookup.
func _unknown_property(node: Node, entries: Dictionary, name: String) -> Dictionary:
	var valid: Array = []
	for candidate in entries:
		var usage := int(entries[candidate].get("usage", 0))
		if usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_SCRIPT_VARIABLE) != 0:
			valid.append(candidate)
	valid.sort()
	return _err("unknown_property", "'%s' is not a property of %s. Valid properties: %s" % [name, node.get_class(), ", ".join(valid)], [
		"Pick one of the listed names.",
		"Read current values with read_node_properties.",
	])


## Encodes one live property value for the wire (READ direction, carried
## from 1.0): bool/int/float/String travel as native JSON, null as JSON
## null (v2 departure - see file header), every other Variant type as its
## var_to_str text form, e.g. "Vector2(100, 50)" or
## 'Resource("res://textures/sprite.png")'.
func encode_property_value(value: Variant) -> Variant:
	# A cleared Object-typed property (e.g. after setting a Resource-typed
	# property to null) reads back as a Variant of type OBJECT wrapping a
	# null pointer, NOT TYPE_NIL - var_to_str's null-Object case would print
	# it as the literal text "null" (a String, not JSON null). The `==` op
	# treats a null-Object Variant as equal to the `null` literal regardless
	# of its type tag, so check equality before the type match.
	if value == null:
		return null
	match typeof(value):
		TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		_:
			return var_to_str(value)


## Decodes one wire value (WRITE direction, carried from 1.0): non-string
## JSON primitives pass through; a string is tried through str_to_var and
## used literally when that yields null (str_to_var's "not a Godot literal"
## signal). str_to_var can only build value types - never a Resource, never
## code - so a value alone can never load or execute anything. The set
## path's type-directed res:// branch runs BEFORE this, and only for
## Resource-typed target properties.
func decode_property_value(raw_value: Variant) -> Variant:
	if typeof(raw_value) != TYPE_STRING:
		return raw_value
	var decoded: Variant = str_to_var(raw_value)
	if decoded == null:
		return raw_value
	return decoded


## node/set_properties: set one or more properties in ONE UndoRedo action
## (REQ-C-06 write half, REQ-M-05). Validate-then-mutate: every name checked
## and every value fully decoded BEFORE anything is registered, so a bad
## entry rejects the whole call with the scene untouched. Old values are
## captured as add_undo_property pairs - the inspector's own mechanism - so
## Ctrl+Z reverts the entire batch and redo re-applies it. The result echoes
## the touched properties re-read through the codec post-commit: the
## set->get round-trip proof in one response.
func _op_set_properties(params: Dictionary) -> Dictionary:
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		return _err("no_current_scene", "There is no open scene to set properties in.", [
			"Open or create a scene first with open_scene or create_scene.",
		])
	var node_path := str(params.get("node_path", ""))
	var node := _resolve_node(scene_root, node_path)
	if node == null:
		return _err("node_not_found", "No node exists at node_path '%s'." % node_path, [
			"Read the tree with get_scene_tree to see valid node paths.",
		])
	var raw: Dictionary = params.get("properties") if typeof(params.get("properties")) == TYPE_DICTIONARY else {}
	if raw.is_empty():
		return _err("invalid_value", "properties must contain at least one name -> value entry.", [
			"Pass e.g. {\"position\": \"Vector2(100, 50)\"}.",
		])
	var entries := _property_entries(node)
	var decoded := {}
	for raw_name in raw:
		var name := str(raw_name)
		if not entries.has(name):
			return _unknown_property(node, entries, name)
		var outcome := _decode_for_entry(entries[name], raw[raw_name])
		if outcome.has("error"):
			return outcome
		decoded[name] = outcome["value"]
	var undo := EditorInterface.get_editor_undo_redo()
	undo.create_action("Set properties on %s" % node.name, UndoRedo.MERGE_DISABLE, scene_root)
	for name in decoded:
		undo.add_do_property(node, name, decoded[name])
		undo.add_undo_property(node, name, node.get(name))
	undo.commit_action()
	server._dirty_scenes[scene_root.scene_file_path] = true
	var readback := {}
	for name in decoded:
		readback[name] = encode_property_value(node.get(name))
	return {"result": {
		"node_path": str(scene_root.get_path_to(node)),
		"properties": readback,
	}}


## Decodes one wire value against its target property's DECLARED type (its
## get_property_list entry). The res:// branch is the absorbed 1.0
## load_sprite, generalized (spec decision 3): it fires ONLY for
## Object-typed properties, so a String property assigned "res://foo" keeps
## the literal string, and a value can never load a resource into a
## property that doesn't declare one. null clears Object-typed properties
## and is a guided error everywhere else. Returns {"value": Variant} or a
## structured error Dictionary.
func _decode_for_entry(entry: Dictionary, raw_value: Variant) -> Dictionary:
	var is_object := int(entry.get("type", TYPE_NIL)) == TYPE_OBJECT
	if raw_value == null:
		if is_object:
			return {"value": null}
		return _err("invalid_value", "null can only clear Object-typed properties; '%s' is not one." % str(entry["name"]), [
			"Send a value of the property's type instead.",
		])
	if is_object and typeof(raw_value) == TYPE_STRING and str(raw_value).begins_with("res://"):
		return _load_resource_value(entry, str(raw_value))
	return {"value": decode_property_value(raw_value)}


## The res:// load path (REQ-M-01 defense-in-depth on a VALUE): containment,
## existence, load, then a class check against the property's declared
## resource class(es) - hint_string, comma-separated for multi-class hints,
## falling back to class_name then "Resource". A hinted class ClassDB does
## not know (a script class) is accepted unchecked - is_class only sees
## native classes.
func _load_resource_value(entry: Dictionary, path: String) -> Dictionary:
	if "/../" in path or path.ends_with("/.."):
		return _err("path_escape", "'%s' is not a valid in-project res:// path." % path, [
			"Pass a res:// path with no '..' segments.",
		])
	if not ResourceLoader.exists(path):
		return _err("resource_not_found", "No resource exists at %s." % path, [
			"Check the path with list_resources.",
		])
	var resource := ResourceLoader.load(path)
	if resource == null:
		return _err("resource_not_found", "Godot could not load the resource at %s." % path, [
			"Check the editor Output panel for import errors.",
		])
	var expected := str(entry.get("hint_string", ""))
	if expected == "":
		expected = str(entry.get("class_name", ""))
	if expected == "":
		expected = "Resource"
	for accepted_raw in expected.split(","):
		var accepted: String = accepted_raw.strip_edges()
		if not ClassDB.class_exists(accepted) or resource.is_class(accepted):
			return {"value": resource}
	return _err("resource_type_mismatch", "%s is a %s, but property '%s' expects %s." % [path, resource.get_class(), str(entry["name"]), expected], [
		"Pick a resource of the expected type.",
	])
