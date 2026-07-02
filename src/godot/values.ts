import { z } from "zod";

/**
 * One property value as it travels over this MCP server's JSON wire format,
 * in either direction. `add_node`'s `properties` param is the first
 * consumer; every later mutation/read-back tool reuses the same contract
 * (see `godot-prd.md` §3 "Value encoding").
 *
 * JSON primitives (`bool`/`int`/`float`/`string`) travel natively and are
 * used as-is. Every other Godot type (`Vector2`, `Color`, `NodePath`,
 * `Rect2`, ...) travels as the text form Godot's own
 * `var_to_str`/`str_to_var` produce and accept - e.g. `"Vector2(100, 50)"`,
 * `"Color(1, 0, 0, 1)"`, `'NodePath("../Foo")'`. That is exactly the syntax
 * already used inside `.tscn` files, so an agent that has read a scene file
 * already knows the encoding.
 *
 * Decoding happens Godot-side, in `operations.gd`'s `decode_property_value`:
 * every string value is first tried through `str_to_var`; only when that
 * yields `null` (str_to_var's signal for "not a recognized Godot literal")
 * is it treated as a literal string instead. `str_to_var` can only build
 * value types (Vector2, Color, arrays, dictionaries, ...) - never a
 * Resource and never a script call - so a property value can never be used
 * to `load()` an arbitrary resource or run code.
 *
 * One caveat this trade-off accepts: a JSON *string* value that happens to
 * look like another Godot literal (e.g. the string `"true"` or `"123"`)
 * decodes as that literal, not as a literal string. To send `true` or `123`
 * as themselves, send real JSON boolean/number primitives - which callers
 * should be doing anyway, since JSON primitives are always the *native*,
 * preferred encoding for those types.
 */
export type PropertyValue = string | number | boolean;

/** Zod schema for one property value in the shared codec (see `PropertyValue`). */
export const propertyValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Zod schema for an `add_node`/future-mutation-tool `properties` object:
 * property name -> encoded value (see `PropertyValue`).
 */
export const propertiesSchema = z.record(z.string(), propertyValueSchema);
