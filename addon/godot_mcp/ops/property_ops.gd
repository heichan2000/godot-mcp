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
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
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
