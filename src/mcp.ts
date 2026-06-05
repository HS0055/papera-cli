// Papera MCP server (stdio transport).
//
// Exposes Papera's "prompt → durable notebook" power to any MCP host
// (Claude Desktop, Cursor, …) as three tools. The whole point: when an agent
// would otherwise dump a wall of text ("here's your meal plan…"), it instead
// produces a real, structured, editable Papera page the user can return to.
//
// IMPORTANT: stdio transport owns stdout for the JSON-RPC protocol. Never
// write to stdout here — diagnostics go to stderr only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
} from "./config.js";
import { PaperaClient, PaperaError } from "./client.js";

function makeClient(): PaperaClient {
  const cfg = loadConfig();
  return new PaperaClient({
    apiUrl: resolveApiUrl(cfg),
    appUrl: resolveAppUrl(cfg),
    apiKey: resolveApiKey(cfg),
  });
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function errorToText(e: unknown): string {
  if (e instanceof PaperaError) {
    if (e.status === 401 || e.code === "no_credentials") {
      return "Not authenticated with Papera. Set PAPERA_API_KEY in the MCP server config (get a key by running `papera login`).";
    }
    if (e.status === 402) {
      return `Out of Ink: ${e.message} The user can top up at https://papera.io/app.`;
    }
    if (e.status === 429) {
      return `Rate limited by Papera: ${e.message} Try again shortly.`;
    }
    return `Papera error: ${e.message}`;
  }
  return `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
}

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "papera", version: "0.1.0" });

  server.registerTool(
    "papera_create_page",
    {
      description:
        "Turn a prompt into a REAL, structured, editable Papera notebook page (a tracker, planner, journal, dashboard — not a wall of text). Use this whenever the user asks you to build, plan, or organize something they'll want to keep and return to: weekly meal planners, habit/finance/fitness trackers, training plans, sprint boards, reading logs, etc. Returns a URL the user opens in Papera. Each page costs Ink from the user's account.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe(
            'What to build, as a natural-language request. Be specific and self-contained, e.g. "4-week marathon training plan with weekly mileage and a long-run tracker" or "ADHD-friendly morning routine checklist".',
          ),
        pageCount: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How many pages to generate (1-5). Defaults to 1. Each page costs Ink."),
        notebookId: z
          .string()
          .optional()
          .describe(
            "Append the new page(s) to this existing notebook instead of creating a new one. Get ids from papera_list_notebooks. Omit to create a fresh notebook.",
          ),
        notebookTitle: z
          .string()
          .optional()
          .describe("Title for the new notebook. Defaults to the generated page title. Ignored when appending."),
      },
    },
    async ({ prompt, pageCount, notebookId, notebookTitle }) => {
      try {
        const client = makeClient();
        const result = await client.createPageFromPrompt(prompt, {
          pageCount,
          notebookId,
          notebookTitle,
        });
        const verb = result.appended
          ? `Added ${result.pageCount} page(s) to "${result.title}"`
          : `Created the Papera notebook "${result.title}" with ${result.pageCount} page(s)`;
        return textResult(
          `${verb}. It's a real, editable page — open it here:\n${result.url}\n\nnotebookId: ${result.notebookId}`,
        );
      } catch (e) {
        return textResult(errorToText(e), true);
      }
    },
  );

  server.registerTool(
    "papera_list_notebooks",
    {
      description:
        "List the user's Papera notebooks (title, page count, and open URL). Use this to find a notebookId before appending a page, or to show the user what they already have.",
      inputSchema: {},
    },
    async () => {
      try {
        const client = makeClient();
        const notebooks = await client.listNotebooks();
        if (notebooks.length === 0) {
          return textResult("The user has no Papera notebooks yet.");
        }
        const lines = notebooks.map(
          (nb) =>
            `• ${nb.title} — ${nb.pageCount} page(s)\n  id: ${nb.id}\n  ${nb.url}`,
        );
        return textResult(`Papera notebooks (${notebooks.length}):\n${lines.join("\n")}`);
      } catch (e) {
        return textResult(errorToText(e), true);
      }
    },
  );

  server.registerTool(
    "papera_get_notebook",
    {
      description:
        "Get one Papera notebook's details: title, open URL, and a per-page summary (title, type, and how many elements/blocks each page has). Use after papera_list_notebooks to inspect a specific notebook.",
      inputSchema: {
        notebookId: z.string().min(1).describe("The notebook id (from papera_list_notebooks)."),
      },
    },
    async ({ notebookId }) => {
      try {
        const client = makeClient();
        const nb = await client.getNotebook(notebookId);
        if (!nb) {
          return textResult(`No notebook found with id ${notebookId}.`, true);
        }
        const pages = (nb.pages ?? []).map((p, i) => {
          const kind = p.version === 2 ? "v2" : "v1";
          const size =
            p.version === 2
              ? `${Array.isArray(p.elements) ? p.elements.length : 0} elements`
              : `${Array.isArray(p.blocks) ? p.blocks.length : 0} blocks`;
          return `  ${i + 1}. ${p.title || "(untitled)"} [${kind}, ${size}]`;
        });
        return textResult(
          `${nb.title}\n${client.notebookUrl(nb.id)}\n\nPages (${pages.length}):\n${pages.join("\n")}`,
        );
      } catch (e) {
        return textResult(errorToText(e), true);
      }
    },
  );

  server.registerTool(
    "papera_get_tracker",
    {
      description:
        "Inspect a notebook's habit/table tracker: its rows, columns (e.g. day labels), and current cell states. Call this BEFORE papera_update_tracker so you know which row and columns to fill. Cell states: 0=empty, 1=partial, 2=full.",
      inputSchema: {
        notebookId: z.string().min(1).describe("The notebook id (from papera_list_notebooks)."),
      },
    },
    async ({ notebookId }) => {
      try {
        const client = makeClient();
        const nb = await client.getNotebook(notebookId);
        if (!nb) return textResult(`No notebook found with id ${notebookId}.`, true);
        const { findTracker } = await import("./trackers.js");
        const hit = findTracker(nb);
        if (!hit) {
          return textResult(`"${nb.title}" has no habit/table tracker to read.`, true);
        }
        const rowLines = hit.rows.map(
          (r, i) => `  ${i + 1}. ${r}: [${(hit.cells[i] ?? []).slice(0, hit.columns).join(",")}]`,
        );
        const cols = hit.columnLabels.length ? hit.columnLabels.join(", ") : `0..${hit.columns - 1}`;
        return textResult(
          `Tracker in "${nb.title}" (page ${hit.pageIndex + 1})\n` +
            `Columns (${hit.columns}): ${cols}\n` +
            `Rows:\n${rowLines.join("\n")}\n\n` +
            `Fill it with papera_update_tracker (states: 0=empty, 1=partial, 2=full).`,
        );
      } catch (e) {
        return textResult(errorToText(e), true);
      }
    },
  );

  server.registerTool(
    "papera_update_tracker",
    {
      description:
        "Fill/update a notebook's habit/table tracker — the 'living tracker' write. Use this to push REAL data into Papera from any source the user has connected (a calendar, bank, GitHub, fitness app, etc.): set the cells of one row for the columns/days that are active. ALWAYS call papera_get_tracker first to learn the exact rows and columns. Cell states: 0=empty, 1=partial, 2=full.",
      inputSchema: {
        notebookId: z.string().min(1).describe("The notebook id (from papera_list_notebooks)."),
        row: z
          .string()
          .min(1)
          .describe("Which row to fill — its label (case-insensitive substring) or its 1-based number."),
        cells: z
          .array(
            z.object({
              column: z
                .union([z.number().int(), z.string()])
                .describe("Column as a 0-based index or its label (e.g. \"Mon\")."),
              state: z.number().int().min(0).max(2).describe("0=empty, 1=partial, 2=full."),
            }),
          )
          .min(1)
          .describe("The cells to set in that row."),
      },
    },
    async ({ notebookId, row, cells }) => {
      try {
        const client = makeClient();
        const nb = await client.getNotebook(notebookId);
        if (!nb) return textResult(`No notebook found with id ${notebookId}.`, true);
        const { findTracker, resolveRow, resolveColumn, applyCells } = await import("./trackers.js");
        const hit = findTracker(nb);
        if (!hit) return textResult(`"${nb.title}" has no habit/table tracker to update.`, true);
        const rowIndex = resolveRow(hit, row);
        if (rowIndex < 0) {
          return textResult(`No row matching "${row}". Rows: ${hit.rows.join(", ")}`, true);
        }
        const updates = cells
          .map((c) => ({ col: resolveColumn(hit, c.column), state: c.state }))
          .filter((u) => u.col >= 0);
        if (updates.length === 0) {
          const cols = hit.columnLabels.length ? hit.columnLabels.join(", ") : `0..${hit.columns - 1}`;
          return textResult(`No valid columns. Columns: ${cols}`, true);
        }
        applyCells(hit, rowIndex, updates);
        await client.saveNotebook({
          id: nb.id,
          title: nb.title,
          coverColor: nb.coverColor,
          bookmarks: nb.bookmarks ?? [],
          pages: nb.pages as unknown[],
        });
        return textResult(
          `Updated "${hit.rows[rowIndex]}" in "${nb.title}" — set ${updates.length} cell(s).\n${client.notebookUrl(nb.id)}`,
        );
      } catch (e) {
        return textResult(errorToText(e), true);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connected. Stay alive on stdio until the host disconnects.
  process.stderr.write("papera MCP server running on stdio\n");
}
