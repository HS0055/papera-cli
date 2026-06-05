# papera

**Turn a prompt, a document, or a goal into a real, structured, editable notebook — from your terminal or your AI assistant.**

Most AI gives you a wall of text you'll lose by tomorrow. `papera` turns that intent into a durable, editable **Papera** notebook page — a planner, tracker, plan, or a clean write-up of your own files — that you keep and come back to.

It's two things in one package:

- a **CLI** — `papera plan "launch my newsletter in 30 days"`
- an **MCP server** — so Claude, ChatGPT, Cursor, and Codex can build Papera pages directly.

> The job it does: **the blank page / messy pile → structure.** Point it at a goal, a prompt, or your documents and get back a real, editable page — not another throwaway chat answer.

---

## Install

```bash
npm install -g papera
# or run without installing:
npx papera --help
```

## Sign in

```bash
papera login
# email + password → a long-lived API key saved to ~/.papera/config.json
```

The CLI never stores your password — it mints a revocable API key (`papera_live_…`). For headless/MCP use, provide it via the `PAPERA_API_KEY` environment variable instead.

---

## CLI

### Generate (the core)

```bash
# A page from a prompt
papera new "ADHD-friendly morning routine tracker"
papera new "sprint retro board" --pages 3 --open

# A multi-step plan from a goal (single or multi-page)
papera plan "launch my newsletter in 30 days"

# Your documents → a structured, multi-page notebook (reads files in full)
papera doc ./notes.md ./spec.html ./research.txt
```

Every generation shows the **Ink cost** (Papera's AI credit) and asks before spending.

### Browse

```bash
papera list                 # your notebooks
papera open <id|number>     # open in the browser
```

### Interactive console

```bash
papera                      # a guided menu: explains itself and asks what you want
papera chat                 # an agent that reads your current folder and builds pages
```

### Connections (optional — living trackers)

`papera` can act as an **MCP client**: connect to your *own* MCP servers (calendar, bank, GitHub, anything) and let the chat agent pull from them to keep a habit tracker current. Auth lives in **those** servers — Papera stores no provider keys.

```bash
papera connections          # list your connected MCP servers + their tools
```
Configure them in `~/.papera/mcp.json` (same format as Claude Desktop). Then in `papera chat`: *"fill my Exercise row from this week's calendar."*

> This is a deliberate niche: it's useful when you already keep the notebook and want to skip manual logging — not as a live data mirror.

---

## Use with Claude Desktop / Cursor / Codex / ChatGPT (MCP)

`papera mcp` runs an MCP server over stdio. Add it to your host so the assistant can build Papera pages as part of its work.

**Claude Desktop / Cursor** (`mcpServers`):
```json
{
  "mcpServers": {
    "papera": {
      "command": "npx",
      "args": ["-y", "papera", "mcp"],
      "env": { "PAPERA_API_KEY": "papera_live_…" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.papera]
command = "npx"
args = ["-y", "papera", "mcp"]
env = { PAPERA_API_KEY = "papera_live_…" }
```

Then: *"plan a 4-week marathon build and put it in Papera"* → the assistant calls Papera and hands back a link.

### MCP tools

| Tool | What it does |
|---|---|
| `papera_create_page` | Turn a prompt into a real, editable Papera page. Returns an open URL. |
| `papera_list_notebooks` | List the user's notebooks. |
| `papera_get_notebook` | Inspect one notebook's pages. |
| `papera_get_tracker` | Read a notebook's habit tracker (rows, columns, cells). |
| `papera_update_tracker` | Write cells into a tracker — fill a living tracker from any source the host has connected. |

---

## Configuration

Resolution order for every value: **environment variable → `~/.papera/config.json` → built-in default**.

| Variable | Purpose | Default |
|---|---|---|
| `PAPERA_API_KEY` | API key for auth (preferred for MCP/CI) | — (else stored config) |
| `PAPERA_API_URL` | Backend HTTP base | `https://veracious-pony-145.convex.site` |
| `PAPERA_APP_URL` | Web app origin for open URLs | `https://papera.io` |
| `OPENAI_API_KEY` | optional — `papera plan` uses your GPT instead of Papera's brain | — |
| `GEMINI_API_KEY` | optional — offline fallback brain for `papera chat` | — |

## Library (experimental)

The same client is also importable: `import { PaperaClient } from "papera"`. Treat the HTTP API as `0.x`/experimental for now.

## License

[Apache-2.0](./LICENSE) © Papera
