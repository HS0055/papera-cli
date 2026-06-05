#!/usr/bin/env node
// Papera CLI — turn a sentence into a real, editable Papera notebook from your
// terminal, and expose the same power to AI agents via `papera mcp`.

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
  CONFIG_PATH,
} from "./config.js";
import { PaperaClient, PaperaError } from "./client.js";
import type { DocOptions } from "./doc.js";
import type { PlanOptions } from "./plan.js";

const VERSION = "0.1.0";

function makeClient(): PaperaClient {
  const cfg = loadConfig();
  return new PaperaClient({
    apiUrl: resolveApiUrl(cfg),
    appUrl: resolveAppUrl(cfg),
    apiKey: resolveApiKey(cfg),
  });
}

// The interactive console. Opens the guided HOME menu — it explains what
// Papera is, asks what you want (numbered choices), and walks you through each
// flow (idea→page, docs→notebook, chat, notebooks, tracker, account), always
// showing Ink cost before spending. Bare `papera` and `papera ui` route here.
// (Chat's brain runs server-side, so no personal Gemini key is needed.)
async function openConsole(): Promise<void> {
  const { runHome } = await import("./home.js");
  await runHome();
}

function die(message: string, hint?: string): never {
  process.stderr.write(`\x1b[31m✖\x1b[0m ${message}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.exit(1);
}

function ok(message: string): void {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${message}\n`);
}

function handleError(e: unknown): never {
  if (e instanceof PaperaError) {
    if (e.status === 401) {
      die(e.message, "Run `papera login`, or set PAPERA_API_KEY.");
    }
    if (e.status === 402 || e.code === "insufficient_ink") {
      die(e.message, "Top up Ink at https://papera.io/app or upgrade your plan.");
    }
    if (e.status === 429) {
      die(e.message, "You're being rate-limited — wait a moment and retry.");
    }
    die(e.message);
  }
  die((e as Error)?.message ?? String(e));
}

function prompt(question: string, { hidden = false } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) {
    // Mute echo for password entry.
    const out = process.stdout as unknown as { write: (s: string) => boolean };
    const orig = out.write.bind(out);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (
      s: string,
    ) => {
      if (s.includes(question)) orig(question);
      else orig("*");
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Non-fatal — the URL is already printed.
  }
}

const program = new Command();

program
  .name("papera")
  .description("Turn any prompt into a real, editable Papera notebook.")
  .version(VERSION);

// Bare `papera` in an interactive terminal opens the console; piped/scripted
// use still prints help (so it stays scriptable).
program.action(async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await openConsole();
  } else {
    program.help();
  }
});

// ── ui ─────────────────────────────────────────────────────────────────────
program
  .command("ui")
  .aliases(["start", "console"])
  .description("Open the interactive Papera console (smart assistant when a Gemini key is set)")
  .action(async () => {
    await openConsole();
  });

// ── login ──────────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Sign in and store a long-lived API key in ~/.papera/config.json")
  .option("-e, --email <email>", "account email")
  .action(async (options: { email?: string }) => {
    const client = makeClient();
    try {
      const email = options.email || (await prompt("Email: "));
      if (!email) die("Email is required.");
      const password = await prompt("Password: ", { hidden: true });
      if (!password) die("Password is required.");

      const { key, email: confirmedEmail } = await client.login(email, password);
      const cfg = loadConfig();
      saveConfig({ ...cfg, apiKey: key, email: confirmedEmail });
      ok(`Logged in as ${confirmedEmail}.`);
      process.stdout.write(`  API key saved to ${CONFIG_PATH}\n`);
    } catch (e) {
      handleError(e);
    }
  });

// ── logout ─────────────────────────────────────────────────────────────────
program
  .command("logout")
  .description("Remove the stored API key")
  .action(() => {
    const cfg = loadConfig();
    delete cfg.apiKey;
    delete cfg.email;
    saveConfig(cfg);
    ok("Logged out (local key removed).");
  });

// ── whoami ─────────────────────────────────────────────────────────────────
program
  .command("whoami")
  .description("Show the current login")
  .action(() => {
    const cfg = loadConfig();
    const key = resolveApiKey(cfg);
    if (!key) die("Not logged in.", "Run `papera login`.");
    const via = process.env.PAPERA_API_KEY ? "PAPERA_API_KEY env" : CONFIG_PATH;
    ok(`${cfg.email ?? "authenticated"} — key via ${via}`);
  });

// ── new ────────────────────────────────────────────────────────────────────
program
  .command("new")
  .description('Generate a notebook from a prompt, e.g. papera new "4-week marathon plan"')
  .argument("<prompt...>", "what to build")
  .option("-p, --pages <n>", "number of pages to generate (1-5)", "1")
  .option("-n, --notebook <id>", "append to an existing notebook instead of creating one")
  .option("-t, --title <title>", "title for the new notebook (defaults to the page title)")
  .option("-o, --open", "open the notebook in your browser when done")
  .action(
    async (
      promptWords: string[],
      options: { pages?: string; notebook?: string; title?: string; open?: boolean },
    ) => {
      const client = makeClient();
      const promptText = promptWords.join(" ").trim();
      if (!promptText) die("A prompt is required.");
      const pageCount = Math.max(1, Math.min(parseInt(options.pages ?? "1", 10) || 1, 5));

      process.stdout.write(
        `\x1b[2m…composing ${pageCount} page${pageCount === 1 ? "" : "s"} for "${promptText}"\x1b[0m\n`,
      );
      try {
        const result = await client.createPageFromPrompt(promptText, {
          notebookId: options.notebook,
          pageCount,
          notebookTitle: options.title,
        });
        ok(
          result.appended
            ? `Added ${result.pageCount} page${result.pageCount === 1 ? "" : "s"} to "${result.title}".`
            : `Created "${result.title}" (${result.pageCount} page${result.pageCount === 1 ? "" : "s"}).`,
        );
        process.stdout.write(`  ${result.url}\n`);
        if (options.open) openInBrowser(result.url);
      } catch (e) {
        handleError(e);
      }
    },
  );

// ── list ───────────────────────────────────────────────────────────────────
program
  .command("list")
  .alias("ls")
  .description("List your notebooks")
  .action(async () => {
    const client = makeClient();
    try {
      const notebooks = await client.listNotebooks();
      if (notebooks.length === 0) {
        process.stdout.write("No notebooks yet. Try: papera new \"weekly meal planner\"\n");
        return;
      }
      for (const nb of notebooks) {
        const pages = `${nb.pageCount} page${nb.pageCount === 1 ? "" : "s"}`;
        process.stdout.write(
          `\x1b[1m${nb.title}\x1b[0m  \x1b[2m${pages}\x1b[0m\n  ${nb.url}\n`,
        );
      }
    } catch (e) {
      handleError(e);
    }
  });

// ── open ───────────────────────────────────────────────────────────────────
program
  .command("open")
  .description("Open a notebook (by id, or the most recent) in your browser")
  .argument("[notebookId]", "notebook id (defaults to the most recent)")
  .action(async (notebookId?: string) => {
    const client = makeClient();
    try {
      let id = notebookId;
      if (!id) {
        const notebooks = await client.listNotebooks();
        if (notebooks.length === 0) die("No notebooks to open.");
        id = notebooks[0].id;
      }
      const url = client.notebookUrl(id);
      process.stdout.write(`${url}\n`);
      openInBrowser(url);
    } catch (e) {
      handleError(e);
    }
  });

// ── sync (living trackers) ─────────────────────────────────────────────────
program
  .command("sync")
  .description("Auto-fill a habit tracker from real data, e.g. papera sync \"Habit Tracker\" --from github")
  .argument("<notebook>", "notebook id or title")
  .option("--from <source>", "data source (github)", "github")
  .option("--row <label>", "tracker row to fill (default: auto-detect a code/dev row)")
  .option("--user <login>", "GitHub username for PUBLIC lookup (when GITHUB_TOKEN isn't set)")
  .option("--dry-run", "show what would be checked, without writing")
  .action(
    async (
      notebook: string,
      options: { from?: string; row?: string; user?: string; dryRun?: boolean },
    ) => {
      const source = (options.from ?? "github").toLowerCase();
      if (source !== "github") die(`Unknown source "${source}". Supported: github.`);
      const { runGithubSync } = await import("./sync.js");
      try {
        await runGithubSync({
          notebook,
          source,
          row: options.row,
          user: options.user,
          dryRun: options.dryRun,
        });
      } catch (e) {
        handleError(e);
      }
    },
  );

// ── plan ───────────────────────────────────────────────────────────────────
program
  .command("plan")
  .description('Turn a goal into a multi-page plan notebook, e.g. papera plan "launch my newsletter in 30 days"')
  .argument("<goal...>", "the goal to plan")
  .option("-p, --pages <n>", "number of pages (default 3, up to 8)")
  .option("-t, --title <title>", "notebook title")
  .option("-y, --yes", "skip the Ink confirmation prompt")
  .option("-o, --open", "open the notebook in your browser when done")
  .action(async (goal: string[], options: PlanOptions) => {
    const { runPlan } = await import("./plan.js");
    await runPlan(goal, options);
  });

// ── openai (store the key for `papera plan`) ────────────────────────────────
program
  .command("openai")
  .description("Store your OpenAI API key so `papera plan` uses GPT (else it uses Papera's brain)")
  .argument("<key>", "your OpenAI API key (sk-…), stored locally in ~/.papera/config.json")
  .action((key: string) => {
    const cfg = loadConfig();
    saveConfig({ ...cfg, openaiKey: key.trim() });
    ok("OpenAI key saved. `papera plan \"<goal>\"` will now plan with GPT.");
  });

// ── doc ────────────────────────────────────────────────────────────────────
program
  .command("doc")
  .description('Turn document(s) into a faithful multi-page notebook (reads in full, splits smart-by-size, shows Ink + confirms first)')
  .argument("<files...>", "one or more file paths to ingest (.md, .txt, .html, …)")
  .option("-p, --pages <n>", "cap the number of pages (default: smart, up to 8)")
  .option("-t, --title <title>", "notebook title (defaults to the file/derived name)")
  .option("-y, --yes", "skip the Ink confirmation prompt")
  .option("-o, --open", "open the notebook in your browser when done")
  .action(async (files: string[], options: DocOptions) => {
    const { runDoc } = await import("./doc.js");
    await runDoc(files, options);
  });

// ── chat ─────────────────────────────────────────────────────────────────
program
  .command("chat")
  .description("Agentic console: reads your current folder and turns anything into a Papera page")
  .action(async () => {
    const { runChat } = await import("./chat.js");
    await runChat();
  });

// ── gemini (store the key for `papera chat`) ───────────────────────────────
program
  .command("gemini")
  .description("Store the Gemini API key that powers `papera chat`")
  .argument("<key>", "your Gemini API key")
  .action((key: string) => {
    const cfg = loadConfig();
    saveConfig({ ...cfg, geminiKey: key.trim() });
    ok("Gemini key saved. Run `papera chat` to start the agentic console.");
  });

// ── github-token (store the read-only token for `papera sync`) ─────────────
program
  .command("github-token")
  .description("Store a read-only GitHub token for `papera sync --from github`")
  .argument("<token>", "a read-only GitHub PAT (stored locally in ~/.papera/config.json)")
  .action((token: string) => {
    const cfg = loadConfig();
    saveConfig({ ...cfg, githubToken: token.trim() });
    ok("GitHub token saved. Run `papera sync \"<tracker>\" --from github`.");
  });

// ── connections (Path B: CLI as MCP client) ────────────────────────────────
program
  .command("connections")
  .aliases(["mcp-list"])
  .description("List your connected MCP servers and their tools (configure in ~/.papera/mcp.json)")
  .action(async () => {
    const { runConnections } = await import("./connections.js");
    await runConnections();
  });

// ── mcp ────────────────────────────────────────────────────────────────────
program
  .command("mcp")
  .description("Run the Papera MCP server over stdio (for Claude Desktop, Cursor, etc.)")
  .action(async () => {
    // Lazy import so the heavy SDK only loads for the MCP path.
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program.parseAsync(process.argv).catch(handleError);
