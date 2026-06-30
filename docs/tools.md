# Tool reference

All tool and parameter names are `snake_case`. `project_path` is required
wherever a project is operated on and anchors path containment — every
file/dir parameter must resolve **inside** `project_path` (absolute paths,
`../`, and symlink escapes are rejected).

## Parity tools (M1)

| Tool | Inputs | Behavior |
|---|---|---|
| `launch_editor` | `project_path` | Open the Godot editor GUI for the project. |
| `run_project` | `project_path`, `scene?` | Run headless (or a scene); capture output into the ring buffer; replaces any active process. |
| `get_debug_output` | — | Return `{ output[], errors[] }` from the ring buffer. |
| `stop_project` | — | Kill the active process; return the captured tail; clear it. |
| `get_godot_version` | — | Return the detected Godot version string. |
| `list_projects` | `directory`, `recursive?` | Find `project.godot` files under `directory`. |
| `get_project_info` | `project_path` | Return name, Godot version, file/asset counts. |
| `create_scene` | `project_path`, `scene_path`, `root_node_type?` | Create a `.tscn` with the given root node. |
| `add_node` | `project_path`, `scene_path`, `node_type`, `node_name`, `parent_node_path?`, `properties?` | Add an allow-listed node under a parent; apply simple properties. |
| `load_sprite` | `project_path`, `scene_path`, `node_path`, `texture_path` | Assign a texture to a Sprite2D/3D node. |
| `export_mesh_library` | `project_path`, `scene_path`, `output_path`, `mesh_item_names?` | Export scene meshes as a `MeshLibrary` `.res`. |
| `save_scene` | `project_path`, `scene_path`, `new_path?` | Save the scene (optionally "save as"). |
| `get_uid`* | `project_path`, `file_path` | Return the resource UID for a file. |
| `update_project_uids`* | `project_path` | Resave resources to refresh UID references. |

<sub>* Requires Godot ≥ 4.4; returns a clear error on older runtimes.</sub>

## Read-back tools (M2 / 1.0)

| Tool | Inputs | Output |
|---|---|---|
| `get_scene_tree` | `project_path`, `scene_path` | Nested `{ name, type, path, children[] }`. |
| `read_node_properties` | `project_path`, `scene_path`, `node_path` | `{ property: value, ... }`. |
| `get_script_errors` | `project_path`, `scene_path?` \| `script_path?` | `[{ file, line, message }]`. |
| `list_resources` | `project_path`, `type?` | `[{ path (res://), type, uid? }]`. |

## Error format

Errors are returned as `{ content, isError: true, possibleSolutions[] }` so
agents can self-correct.
