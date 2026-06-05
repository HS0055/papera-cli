// The Papera home console — what `papera` (and `papera ui`) opens.
//
// Goal: self-explaining + guided. It tells you what Papera is, ASKS what you
// want (a numbered menu), and walks you through each flow — so you never need
// to memorise commands. Every action that spends Ink shows the cost first.
//
// It is a thin router: each choice delegates to the real flow modules
// (chat.ts, doc.ts, sync.ts) or the client, and returns to the menu after.

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import {
  loadConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
  resolveGithubToken,
} from "./config.js";
import { PaperaClient, PaperaError, type NotebookSummary } from "./client.js";

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

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function startSpinner(text: string): () => void {
  let i = 0;
  const t0 = Date.now();
  const tick = () => {
    const el = Math.floor((Date.now() - t0) / 1000);
    const clk = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")}`;
    process.stdout.write(`\r  ${c.brand(BRAILLE[(i = (i + 1) % BRAILLE.length)])} ${text} ${c.dim(clk)}   `);
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

function errMsg(e: unknown): string {
  if (e instanceof PaperaError) {
    if (e.status === 402) return "Out of Ink — top up at papera.io/app.";
    if (e.status === 401) return "Not authenticated — run `papera login`.";
    if (e.status === 429) return "Rate limited — wait a moment.";
    return e.message;
  }
  return (e as Error)?.message ?? String(e);
}

// One-shot prompt: opens a readline, asks, closes. Closing each time avoids
// clashing with the sub-flows (chat/doc) that open their own readline.
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (a) => {
      rl.close();
      res(a.trim());
    });
  });
}
async function confirm(question: string): Promise<boolean> {
  const a = (await ask(question)).toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

// Split a path line that may contain drag-dropped paths: respects "quotes",
// 'quotes', and backslash-escaped spaces (how terminals paste paths).
function splitPaths(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\\") {
      cur += line[++i] ?? "";
    } else if (ch === " ") {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function banner(): void {
  const W = 54;
  const line = (inner: string, vis: number) =>
    `  ${c.brand("│")} ${inner}${" ".repeat(Math.max(0, W - vis))} ${c.brand("│")}`;
  process.stdout.write("\n");
  process.stdout.write(`  ${c.brand("╭" + "─".repeat(W + 2) + "╮")}\n`);
  process.stdout.write(line(c.brandBold("✦ PAPERA"), 8) + "\n");
  process.stdout.write(line(c.dim("Turn ideas & documents into real notebooks"), 42) + "\n");
  process.stdout.write(`  ${c.brand("╰" + "─".repeat(W + 2) + "╯")}\n`);
}

const MENU: { key: string; icon: string; label: string; desc: string }[] = [
  { key: "1", icon: "✦", label: "Make a page from an idea", desc: 'e.g. "weekly meal planner" — ~10 Ink' },
  { key: "2", icon: "▸", label: "Turn documents into a notebook", desc: "read your files → pages (shows Ink first)" },
  { key: "3", icon: "✶", label: "Chat", desc: "ask anything, or build from this folder" },
  { key: "4", icon: "▤", label: "My notebooks", desc: "browse & open in your browser" },
  { key: "5", icon: "↻", label: "Fill a tracker from GitHub", desc: "living tracker — auto-check your activity" },
  { key: "6", icon: "⚙", label: "Account & Ink", desc: "plan and balance" },
  { key: "0", icon: "·", label: "Quit", desc: "" },
];

function printMenu(): void {
  process.stdout.write(`\n  ${c.bold("What do you want to do?")}  ${c.dim("(type a number)")}\n\n`);
  for (const m of MENU) {
    const head = `${c.brand(m.key)}  ${c.brand(m.icon)} ${c.bold(m.label)}`;
    process.stdout.write(`   ${head}${m.desc ? `\n        ${c.dim(m.desc)}` : ""}\n`);
  }
  process.stdout.write("\n");
}

export async function runHome(): Promise<void> {
  const cfg = loadConfig();
  const apiKey = resolveApiKey(cfg);
  const client = new PaperaClient({
    apiUrl: resolveApiUrl(cfg),
    appUrl: resolveAppUrl(cfg),
    apiKey,
  });

  banner();
  process.stdout.write(
    c.dim("  Papera makes real, editable notebook pages from a prompt or your files.\n") +
      c.dim("  Pages cost Ink (AI credits) — you'll always see the cost before it spends.\n"),
  );

  if (!apiKey) {
    process.stdout.write(`\n  ${c.yellow("You're not logged in.")} Run ${c.bold("papera login")} first, then come back.\n\n`);
    return;
  }

  // Account header (best-effort).
  try {
    const a = await client.getAccount();
    const meta = [a.plan, a.ink != null ? `${a.ink} Ink` : null].filter(Boolean).join(" · ");
    process.stdout.write(`\n  ${c.green("●")} ${a.email ?? "signed in"}   ${c.dim(meta)}\n`);
  } catch {
    /* header is non-essential */
  }

  let notebooks: NotebookSummary[] = [];

  for (;;) {
    printMenu();
    const choice = (await ask(`  ${c.brandBold("papera")} ${c.brand("›")} `)).toLowerCase();

    if (choice === "0" || choice === "q" || choice === "quit" || choice === "exit") break;

    // 1 — idea → one page
    if (choice === "1") {
      const idea = await ask(`  ${c.dim("Describe the page:")} `);
      if (!idea) { process.stdout.write(c.dim("  (nothing entered)\n")); continue; }
      if (!(await confirm(`  ${c.dim("Create it for")} ${c.brandBold("~10 Ink")}${c.dim("? [Y/n]")} `))) {
        process.stdout.write(c.dim("  okay, skipped.\n"));
        continue;
      }
      const stop = startSpinner(`composing "${idea}"`);
      try {
        const r = await client.createPageFromPrompt(idea, {});
        stop();
        process.stdout.write(`  ${c.green("✓")} ${c.bold(r.title)}\n    ${c.brand(r.url)}\n`);
        openInBrowser(r.url);
      } catch (e) {
        stop();
        process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n`);
      }
      continue;
    }

    // 2 — documents → multi-page notebook (delegates to the doc pipeline)
    if (choice === "2") {
      process.stdout.write(
        c.dim("  Paste or drag file path(s) here (space-separated). .md/.txt/.html …\n"),
      );
      const line = await ask(`  ${c.dim("Files:")} `);
      const paths = splitPaths(line);
      if (paths.length === 0) { process.stdout.write(c.dim("  (no files)\n")); continue; }
      const { runDoc } = await import("./doc.js");
      await runDoc(paths, { open: true }); // runDoc shows the Ink plan + confirms itself
      continue;
    }

    // 3 — chat (its own loop until /quit)
    if (choice === "3") {
      const { runChat } = await import("./chat.js");
      await runChat();
      continue;
    }

    // 4 — notebooks
    if (choice === "4") {
      const stop = startSpinner("loading notebooks");
      try {
        notebooks = await client.listNotebooks();
      } catch (e) {
        stop();
        process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n`);
        continue;
      }
      stop();
      if (notebooks.length === 0) { process.stdout.write(c.dim("  No notebooks yet — try option 1 or 2.\n")); continue; }
      process.stdout.write("\n");
      notebooks.forEach((nb, i) =>
        process.stdout.write(`   ${c.brand(String(i + 1).padStart(2))}  ${c.bold(nb.title)}  ${c.dim(`${nb.pageCount}p`)}\n`),
      );
      const pick = await ask(`\n  ${c.dim("Open which # (Enter to skip):")} `);
      if (/^\d+$/.test(pick)) {
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < notebooks.length) {
          const url = client.notebookUrl(notebooks[idx].id);
          process.stdout.write(`  ${c.brand(url)}\n`);
          openInBrowser(url);
        } else process.stdout.write(c.dim("  no notebook at that number.\n"));
      }
      continue;
    }

    // 5 — living tracker (GitHub)
    if (choice === "5") {
      const nb = await ask(`  ${c.dim("Tracker notebook (name or id):")} `);
      if (!nb) { process.stdout.write(c.dim("  (nothing entered)\n")); continue; }
      const hasToken = !!resolveGithubToken(cfg);
      let user: string | undefined;
      if (!hasToken) {
        process.stdout.write(
          c.dim("  No GitHub token set (it would read private commits). Using public events.\n"),
        );
        user = (await ask(`  ${c.dim("GitHub username (for public commits):")} `)) || undefined;
      }
      const { runGithubSync } = await import("./sync.js");
      try {
        await runGithubSync({ notebook: nb, source: "github", user, dryRun: false });
      } catch (e) {
        process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n`);
      }
      continue;
    }

    // 6 — account
    if (choice === "6") {
      try {
        const a = await client.getAccount();
        process.stdout.write(
          `  ${c.green("●")} ${a.email ?? "?"}  ${c.dim(`${a.plan ?? ""} · ${a.ink ?? "?"} Ink`)}\n`,
        );
      } catch (e) {
        process.stdout.write(`  ${c.red("✖")} ${errMsg(e)}\n`);
      }
      continue;
    }

    process.stdout.write(c.dim("  Type one of the numbers above (0 to quit).\n"));
  }

  process.stdout.write(c.dim("\n  bye 👋\n\n"));
}
