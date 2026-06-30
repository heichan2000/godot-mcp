# Per-client setup

> Requires **Node ≥ 20** and **Godot 4.x**. The MCP client registration name is plain `godot`.

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@heichan2000/godot-mcp"],
      "env": { "GODOT_PATH": "/absolute/path/to/godot" }
    }
  }
}
```

## Claude Code (CLI)

```sh
claude mcp add godot -- npx -y @heichan2000/godot-mcp
```

## Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "godot": { "command": "npx", "args": ["-y", "@heichan2000/godot-mcp"] }
  }
}
```

## Cline

Add an MCP server with command `npx` and args `["-y", "@heichan2000/godot-mcp"]`.

## Godot path resolution

Resolution is strict — `config → GODOT_PATH → autodetect` — with **no silent
fallback**. If Godot can't be found you get a structured error listing the
candidate paths it tried and how to set `GODOT_PATH`.

## Least privilege

Run the server scoped to a directory that holds your Godot projects. Never run
it as administrator/root. Every file/dir parameter is contained to the call's
`project_path`.
