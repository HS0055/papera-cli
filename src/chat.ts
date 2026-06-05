// `papera chat` — an agentic terminal console.
//
// Unlike the plain generator, this is a real assistant: it runs inside your
// current folder, can READ your files to ground its work, and turns ANYTHING
// you ask for — a checklist from your TODOs, a summary of the codebase, a plan,
// a layout — into a Papera notebook. Think "Claude Code, output = a Papera page".
//
// The agent is model-driven via a simple JSON-action (ReAct) loop, so it
// doesn't depend on a provider-specific function-calling protocol. Filesystem
// access is READ-ONLY and confined to the working directory.

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  loadConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
  resolveGeminiKey,
} from "./config.js";
import { PaperaClient, PaperaError, type NotebookSummary } from "./client.js";

// ── styling ──────────────────────────────────────────────────────────────
const E = "\x1b[";
const R = E + "0m";
const c = {
  bold: (t: string) => `${E}1m${t}${R}`,
  dim: (t: string) => `${E}2m${t}${R}`,
  red: (t: string) => `${E}31m${t}${R}`,
  green: (t: string) => `${E}32m${t}${R}`,
  yellow: (t: string) => `${E}33m${t}${R}`,
  brand: (t: string) => `${E}38;2;129;140;248m${t}${R}`,
  brandBold: (t: string) => `${E}1m${E}38;2;129;140;248m${t}${R}`,
};

function startSpinner(text: string): () => void {
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("");
  let i = 0;
  const t0 = Date.now();
  const tick = () => {
    const el = Math.floor((Date.now() - t0) / 1000);
    const clk = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")}`;
    process.stdout.write(`\r  ${c.brand(frames[(i = (i + 1) % frames.length)])} ${text} ${c.dim(clk)}   `);
  };
  tick();
  const id = setInterval(tick, 80);
  return () => {
    clearInterval(id);
    process.stdout.write("\r" + " ".repeat(76) + "\r");
  };
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* url already printed */
  }
}

// ── read-only filesystem tools (confined to cwd) ───────────────────────────
const ROOT = process.cwd();
const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage",
  ".turbo", ".vercel", "out", ".DS_Store", ".idea", ".vscode",
]);
const MAX_FILE_CHARS = 12_000;
const MAX_DIR_ENTRIES = 200;

function safeAbs(p: string): string {
  const abs = resolve(ROOT, p || ".");
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) {
    throw new Error("path is outside the working directory");
  }
  return abs;
}

function toolListDir(p: string): string {
  const abs = safeAbs(p);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => !IGNORE.has(e.name))
    .slice(0, MAX_DIR_ENTRIES)
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
    .sort();
  return entries.length ? entries.join("\n") : "(empty)";
}

function toolReadFile(p: string): string {
  const abs = safeAbs(p);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error("that's a directory — use list_dir");
  const raw = readFileSync(abs, "utf8");
  if (raw.slice(0, 2000).includes("\u0000")) throw new Error("looks like a binary file");
  return raw.length > MAX_FILE_CHARS
    ? raw.slice(0, MAX_FILE_CHARS) + `\n… [truncated, ${raw.length} chars total]`
    : raw;
}

// ── the agent ──────────────────────────────────────────────────────────────
type GeminiContent = { role: "user" | "model"; parts: { text: string }[] };

const MODEL = process.env.PAPERA_CHAT_MODEL || "gemini-2.5-flash";
const MAX_STEPS = 10; // tool steps per user turn before forcing a reply

function systemPrompt(toolsBlock = ""): string {
  const mcpAction = toolsBlock
    ? `\n- {"action":"mcp_call","server":"<server>","tool":"<tool>","args":{…}}  — call one of the user's connected tools (listed below) to fetch real data`
    : "";
  const mcpCatalog = toolsBlock
    ? `\n\nConnected tools you may call with mcp_call (auth lives in the user's own servers):\n${toolsBlock}`
    : "";
  return `You are Papera's terminal assistant, running inside the user's folder:
${ROOT}

Your job: help the user turn ANYTHING into a Papera notebook page — a checklist, a plan, a tracker, a layout, or a summary of their files — AND keep their living trackers up to date from real data.

Respond with EXACTLY ONE JSON object and nothing else (no prose, no markdown fences). Pick one action:

- {"action":"list_dir","path":"<relative path, '.' for current folder>"}
- {"action":"read_file","path":"<relative path>"}
- {"action":"list_notebooks"}  — list the user's notebooks (to find a notebookId)
- {"action":"reply","message":"<message to the user>"}
- {"action":"create_notebook","title":"<short title>","prompt":"<detailed, self-contained description of the page to generate>"}
- {"action":"update_tracker","notebookId":"<id>","row":"<row label or 1-based number>","cells":[{"column":<0-based index or label>,"state":0|1|2}]}  — fill a habit tracker (0=empty, 1=partial, 2=full)${mcpAction}

Rules:
- Greetings, questions, or vague input → use "reply". NEVER create a notebook unless the user clearly wants one.
- If the user asks what you or Papera can do, ANSWER with "reply". In this console the user can also type /list, /open <n>, /account, /help, /quit.
- Before creating a notebook from the user's files, READ the relevant files first, then put the actual content into the create_notebook "prompt" (self-contained, max ~1900 chars).
- LIVING TRACKERS: to fill a tracker from a connected source (calendar, bank, GitHub…): (1) mcp_call the right tool to GET the data, (2) list_notebooks to find the tracker's notebookId, (3) update_tracker — map the data's dates/values to the tracker's columns/rows. Tell the user what you set.
- Creating a notebook costs Ink (the user confirms). Updating a tracker is free.
- You are READ-ONLY on the filesystem.
- After each Observation, decide the single next action. Keep replies short and concrete.${mcpCatalog}`;
}

// Flatten the running history into the backend's {role, content} shape.
function historyToMessages(
  history: GeminiContent[],
): { role: "user" | "model"; content: string }[] {
  return history.map((h) => ({
    role: h.role,
    content: h.parts.map((p) => p.text).filter(Boolean).join(""),
  }));
}

// Direct Gemini call (BYO key) — the resilience fallback used only when the
// Papera backend brain is unreachable AND a local key is configured.
async function geminiDirect(history: GeminiContent[], apiKey: string, system: string): Promise<string> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: history,
        generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 2048 },
      }),
    },
  );
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${t.slice(0, 160)}`);
  }
  const data = (await resp.json()) as any;
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text)
      .filter(Boolean)
      .join("") ?? ""
  );
}

// Extract the single JSON action object from the model's raw text.
function parseAction(text: string): any {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) cleaned = cleaned.slice(a, b + 1);
  return JSON.parse(cleaned);
}

// One agent turn. Prefers the Papera backend brain (server holds the Gemini
// key → works for any logged-in user with NO personal key); falls back to a
// local Gemini key only if the backend is unreachable and a key is set.
// Pushes the model's reply into history and returns the parsed action.
async function callAgent(
  client: PaperaClient,
  history: GeminiContent[],
  localKey: string | undefined,
  system: string,
): Promise<any> {
  let text: string;
  try {
    text = await client.chatStep(system, historyToMessages(history));
  } catch (e) {
    if (localKey) text = await geminiDirect(history, localKey, system);
    else throw e;
  }
  history.push({ role: "model", parts: [{ text }] });
  return parseAction(text);
}

function errMsg(e: unknown): string {
  if (e instanceof PaperaError) {
    if (e.status === 402) return "Out of Ink — top up at papera.io/app.";
    if (e.status === 401) return "Not authenticated — run `papera login`.";
    return e.message;
  }
  return (e as Error)?.message ?? String(e);
}

// ── console commands (carried over from the simple console so the merged
// default console keeps /list, /open, /account, /help) ─────────────────────
function printChatHelp(): void {
  const rows: [string, string][] = [
    ["<message>", "ask me anything, or describe a page to build"],
    ["/list  /ls", "list your notebooks"],
    ["/open <n|id>", "open a notebook (n = number from /list)"],
    ["/account", "show account + Ink balance"],
    ["/help", "this help"],
    ["/quit  /q", "exit (or Ctrl-C)"],
  ];
  process.stdout.write("\n");
  for (const [cmd, desc] of rows) {
    process.stdout.write(`  ${c.brand(cmd.padEnd(14))} ${c.dim(desc)}\n`);
  }
  process.stdout.write("\n");
}

async function showList(client: PaperaClient): Promise<NotebookSummary[]> {
  let list: NotebookSummary[] = [];
  try {
    list = await client.listNotebooks();
  } catch (e) {
    process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n\n`);
    return [];
  }
  if (list.length === 0) {
    process.stdout.write(c.dim("  No notebooks yet.\n\n"));
    return list;
  }
  process.stdout.write("\n");
  list.forEach((nb, i) => {
    process.stdout.write(
      `  ${c.brand(String(i + 1).padStart(2))}  ${c.bold(nb.title)}  ${c.dim(`${nb.pageCount}p`)}\n`,
    );
  });
  process.stdout.write(c.dim(`\n  open one with  /open <number>\n\n`));
  return list;
}

function openFromList(client: PaperaClient, list: NotebookSummary[], arg: string): void {
  let id = arg.trim();
  if (/^\d+$/.test(id)) {
    const idx = parseInt(id, 10) - 1;
    if (idx < 0 || idx >= list.length) {
      process.stdout.write(c.dim("  No notebook at that number — run /list first.\n\n"));
      return;
    }
    id = list[idx].id;
  }
  if (!id) {
    if (list[0]) id = list[0].id;
    else {
      process.stdout.write(c.dim("  Nothing to open — run /list first.\n\n"));
      return;
    }
  }
  const url = client.notebookUrl(id);
  process.stdout.write(`  ${c.brand(url)}\n\n`);
  openInBrowser(url);
}

async function showAccount(client: PaperaClient): Promise<void> {
  try {
    const a = await client.getAccount();
    process.stdout.write(
      `  ${c.green("●")} ${a.email ?? "?"}  ${c.dim(`${a.plan ?? ""} · ${a.ink ?? "?"} Ink`)}\n\n`,
    );
  } catch (e) {
    process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n\n`);
  }
}

export async function runChat(): Promise<void> {
  const cfg = loadConfig();
  const apiKey = resolveApiKey(cfg);
  const geminiKey = resolveGeminiKey(cfg);
  const client = new PaperaClient({
    apiUrl: resolveApiUrl(cfg),
    appUrl: resolveAppUrl(cfg),
    apiKey,
  });

  const folder = ROOT.split(sep).pop() || ROOT;
  process.stdout.write(
    `\n  ${c.brandBold("✦ papera chat")}  ${c.dim("— I can read this folder and turn anything into a Papera page.")}\n`,
  );
  process.stdout.write(`  ${c.dim("folder:")} ${c.bold(folder)}   ${c.dim(ROOT)}\n`);

  if (!apiKey) {
    process.stdout.write(`\n  ${c.yellow("Not logged in.")} Run ${c.bold("papera login")} first.\n\n`);
    return;
  }
  // No Gemini key needed: the brain runs server-side through the Papera
  // backend. A local key (if set) is only used as an offline fallback.
  process.stdout.write(
    c.dim(`  Ask me anything, or describe a page. Try “what can I do with Papera?” or “make a checklist from TODO.md”. /help for commands.\n\n`),
  );

  // Path B: discover the user's connected MCP servers (calendar, bank, …) so
  // the agent can pull real data and fill living trackers. Best-effort — auth
  // lives in those servers; Papera stores no provider keys.
  let toolsBlock = "";
  try {
    const { loadMcpServers, listAllTools } = await import("./mcp-client.js");
    if (Object.keys(loadMcpServers()).length > 0) {
      const stop = startSpinner("connecting your tools…");
      const { tools, errors } = await listAllTools();
      stop();
      if (tools.length) {
        toolsBlock = tools
          .map((t) => `  - ${t.server}/${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 80)}`)
          .join("\n");
        const nServers = new Set(tools.map((t) => t.server)).size;
        process.stdout.write(c.dim(`  ✦ connected ${tools.length} tool(s) from ${nServers} MCP server(s).\n\n`));
      }
      for (const e of errors) process.stdout.write(c.dim(`  (couldn't reach "${e.server}")\n`));
    }
  } catch {
    /* MCP is optional */
  }
  const system = systemPrompt(toolsBlock);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  let quitting = false;
  rl.on("close", () => (closed = true));
  rl.on("SIGINT", () => {
    quitting = true;
    rl.close();
  });

  const ask = (q: string): Promise<string | null> =>
    new Promise((resolve2) => {
      if (closed) return resolve2(null);
      try {
        rl.question(q, (a) => resolve2(a));
      } catch {
        resolve2(null);
      }
    });

  const history: GeminiContent[] = [];
  let lastList: NotebookSummary[] = [];

  while (!quitting && !closed) {
    const userMsg = (await ask(`${c.brandBold("you")} ${c.brand("›")} `))?.trim();
    if (userMsg === null || userMsg === undefined || quitting) break;
    if (!userMsg) continue;
    if (userMsg === "/quit" || userMsg === "/q" || userMsg === "/exit") break;

    // Console commands (so the merged default console keeps /list, /open, …).
    if (userMsg.startsWith("/")) {
      const sp = userMsg.indexOf(" ");
      const cmd = (sp === -1 ? userMsg : userMsg.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? "" : userMsg.slice(sp + 1);
      if (cmd === "/help" || cmd === "/h" || cmd === "/?") printChatHelp();
      else if (cmd === "/list" || cmd === "/ls") lastList = await showList(client);
      else if (cmd === "/open") openFromList(client, lastList, arg);
      else if (cmd === "/account" || cmd === "/me") await showAccount(client);
      else process.stdout.write(c.dim("  unknown command — try /help\n\n"));
      continue;
    }

    history.push({ role: "user", parts: [{ text: userMsg }] });

    for (let step = 0; step < MAX_STEPS; step++) {
      let action: any;
      const stop = startSpinner(step === 0 ? "thinking…" : "working…");
      try {
        action = await callAgent(client, history, geminiKey, system);
      } catch (e) {
        stop();
        process.stdout.write(`  ${c.red("✖")} ${(e as Error).message}\n\n`);
        break;
      }
      stop();

      const kind = action?.action;
      if (kind === "reply") {
        process.stdout.write(`  ${c.brand("papera")} ${action.message ?? ""}\n\n`);
        break;
      }

      if (kind === "list_dir") {
        process.stdout.write(c.dim(`  ⟢ scanning ${action.path || "."}\n`));
        let obs: string;
        try {
          obs = toolListDir(action.path || ".");
        } catch (e) {
          obs = "ERROR: " + (e as Error).message;
        }
        history.push({ role: "user", parts: [{ text: `Observation (list_dir ${action.path || "."}):\n${obs}` }] });
        continue;
      }

      if (kind === "read_file") {
        process.stdout.write(c.dim(`  ⟢ reading ${action.path}\n`));
        let obs: string;
        try {
          obs = toolReadFile(action.path);
        } catch (e) {
          obs = "ERROR: " + (e as Error).message;
        }
        history.push({ role: "user", parts: [{ text: `Observation (read_file ${action.path}):\n${obs}` }] });
        continue;
      }

      if (kind === "create_notebook") {
        const title = String(action.title || "Untitled");
        const prompt = String(action.prompt || "").slice(0, 1900);
        process.stdout.write(
          `  ${c.dim("Create Papera notebook")} ${c.bold(`"${title}"`)}${c.dim("? [Y/n]")} `,
        );
        const yn = (await ask(""))?.trim().toLowerCase();
        if (!(yn === "" || yn === "y" || yn === "yes")) {
          process.stdout.write(c.dim("  okay, skipped.\n"));
          history.push({ role: "user", parts: [{ text: "Observation: the user declined to create the notebook." }] });
          continue;
        }
        const stop2 = startSpinner(`composing ${c.bold(`"${title}"`)}…`);
        try {
          const r = await client.createPageFromPrompt(prompt, { notebookTitle: title });
          stop2();
          process.stdout.write(`  ${c.green("✓")} ${c.bold(r.title)}  ${c.brand(r.url)}\n`);
          openInBrowser(r.url);
          history.push({ role: "user", parts: [{ text: `Observation: created notebook "${r.title}" at ${r.url}` }] });
        } catch (e) {
          stop2();
          process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n`);
          history.push({ role: "user", parts: [{ text: `Observation: notebook creation failed: ${errMsg(e)}` }] });
        }
        continue;
      }

      if (kind === "list_notebooks") {
        process.stdout.write(c.dim(`  ⟢ listing notebooks\n`));
        let obs: string;
        try {
          const nbs = await client.listNotebooks();
          obs = nbs.length
            ? nbs.map((n) => `${n.title} — id ${n.id} (${n.pageCount}p)`).join("\n")
            : "(no notebooks)";
        } catch (e) {
          obs = "ERROR: " + errMsg(e);
        }
        history.push({ role: "user", parts: [{ text: `Observation (list_notebooks):\n${obs}` }] });
        continue;
      }

      if (kind === "mcp_call") {
        process.stdout.write(c.dim(`  ⟢ ${action.server}/${action.tool}\n`));
        let obs: string;
        try {
          const { callServerTool } = await import("./mcp-client.js");
          obs = (await callServerTool(String(action.server), String(action.tool), action.args || {})).slice(0, 6000);
        } catch (e) {
          obs = "ERROR: " + (e as Error).message;
        }
        history.push({ role: "user", parts: [{ text: `Observation (mcp_call ${action.server}/${action.tool}):\n${obs}` }] });
        continue;
      }

      if (kind === "update_tracker") {
        let obs: string;
        try {
          const nb = await client.getNotebook(String(action.notebookId));
          if (!nb) throw new Error("notebook not found");
          const { findTracker, resolveRow, resolveColumn, applyCells } = await import("./trackers.js");
          const hit = findTracker(nb);
          if (!hit) throw new Error("no habit tracker in that notebook");
          const rowIndex = resolveRow(hit, String(action.row));
          if (rowIndex < 0) throw new Error(`no row "${action.row}" (rows: ${hit.rows.join(", ")})`);
          const cellsIn = Array.isArray(action.cells) ? action.cells : [];
          const updates = cellsIn
            .map((cc: { column: number | string; state: number }) => ({
              col: resolveColumn(hit, cc.column),
              state: Number(cc.state),
            }))
            .filter((u: { col: number }) => u.col >= 0);
          applyCells(hit, rowIndex, updates);
          await client.saveNotebook({
            id: nb.id,
            title: nb.title,
            coverColor: nb.coverColor,
            bookmarks: nb.bookmarks ?? [],
            pages: nb.pages as unknown[],
          });
          process.stdout.write(`  ${c.green("✓")} updated "${hit.rows[rowIndex]}" (${updates.length} cell(s))\n`);
          obs = `Updated row "${hit.rows[rowIndex]}" with ${updates.length} cell(s).`;
        } catch (e) {
          obs = "ERROR: " + (e as Error).message;
          process.stdout.write(`  ${c.red("✖")} ${obs}\n`);
        }
        history.push({ role: "user", parts: [{ text: `Observation (update_tracker):\n${obs}` }] });
        continue;
      }

      // Unknown action shape — surface whatever message it gave and stop.
      process.stdout.write(`  ${c.brand("papera")} ${action?.message ?? c.dim("(no action)")}\n\n`);
      break;
    }
  }

  rl.close();
  process.stdout.write(c.dim("\n  bye 👋\n\n"));
}
