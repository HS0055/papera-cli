// `papera plan "<goal>"` — turn a goal into a real, multi-page plan notebook.
//
// The PLANNING brain is pluggable:
//   - OpenAI (your key) if one is set — "C": the CLI uses your GPT directly,
//     no Papera key, planning billed to your OpenAI account.
//   - else the Papera backend (Gemini) — token-metered Ink, no setup.
// Either way, each planned section becomes one v2 page (10 Ink/page), and the
// Ink cost is shown + confirmed before anything is spent.

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import {
  loadConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
  resolveOpenaiKey,
} from "./config.js";
import { PaperaClient, PaperaError } from "./client.js";

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

const V2_INK_PER_PAGE = 10;
const MAX_PAGES = 8;
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

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (a) => {
      rl.close();
      const v = a.trim().toLowerCase();
      res(v === "" || v === "y" || v === "yes");
    });
  });
}

function errMsg(e: unknown): string {
  if (e instanceof PaperaError) {
    if (e.status === 402) return "Out of Ink - top up at papera.io/app.";
    if (e.status === 401) return "Not authenticated - run `papera login`.";
    if (e.status === 429) return "Rate limited - wait a moment.";
    return e.message;
  }
  return (e as Error)?.message ?? String(e);
}

export interface PlanOptions {
  pages?: string;
  title?: string;
  yes?: boolean;
  open?: boolean;
}

export async function runPlan(goalWords: string[], opts: PlanOptions): Promise<void> {
  const cfg = loadConfig();
  const apiKey = resolveApiKey(cfg);
  const client = new PaperaClient({
    apiUrl: resolveApiUrl(cfg),
    appUrl: resolveAppUrl(cfg),
    apiKey,
  });
  if (!apiKey) {
    process.stdout.write(`\n  ${c.yellow("Not logged in.")} Run ${c.bold("papera login")} first.\n\n`);
    return;
  }
  const goal = goalWords.join(" ").trim();
  if (!goal) {
    process.stdout.write(`  ${c.red("x")} A goal is required, e.g. papera plan "launch my newsletter in 30 days".\n\n`);
    return;
  }

  const pages = Math.min(opts.pages ? Math.max(1, parseInt(opts.pages, 10) || 1) : 3, MAX_PAGES);
  const openaiKey = resolveOpenaiKey(cfg);
  const brain = openaiKey ? "OpenAI (your key)" : "Papera (Gemini)";
  const genInk = pages * V2_INK_PER_PAGE;

  process.stdout.write(`\n  ${c.brandBold("papera plan")}  ${c.dim(`brain: ${brain}`)}\n`);
  process.stdout.write(`  ${c.bold("Goal")}: ${goal}\n`);
  process.stdout.write(`  ${c.bold("Plan")}: ~${pages} page${pages === 1 ? "" : "s"}\n`);
  process.stdout.write(
    `  ${c.bold("Ink")}:  ${c.brandBold(`~ ${genInk}`)} ${c.dim(`= ${pages} x ${V2_INK_PER_PAGE}/page generate`)}` +
      `${openaiKey ? c.dim(" · planning runs on YOUR OpenAI key ($, no Ink)") : c.dim(" + ~1 Ink planning")}\n`,
  );

  if (!opts.yes) {
    const ok = await confirm(`  ${c.dim("Build this plan for")} ${c.brandBold(`~ ${genInk} Ink`)}${c.dim("? [Y/n]")} `);
    if (!ok) {
      process.stdout.write(c.dim("  okay, nothing generated.\n\n"));
      return;
    }
  }

  // 1. Plan into sections (OpenAI if available, else the Papera backend brain).
  const stopPlan = startSpinner(`planning with ${openaiKey ? "OpenAI" : "Papera"}`);
  let sections: { title: string; prompt: string }[];
  try {
    if (openaiKey) {
      const { openaiPlanGoal } = await import("./openai.js");
      sections = await openaiPlanGoal(goal, pages, openaiKey);
    } else {
      sections = await client.planGoalSections(goal, pages);
    }
  } catch (e) {
    stopPlan();
    process.stdout.write(`  ${c.red("x")} planning failed: ${errMsg(e)}\n\n`);
    return;
  }
  stopPlan();
  if (sections.length === 0) {
    process.stdout.write(`  ${c.red("x")} The planner produced no sections. Try again.\n\n`);
    return;
  }

  // 2. Generate one v2 page per planned section.
  const title = opts.title?.trim() || deriveTitle(goal);
  const stopGen = startSpinner(`composing "${title}" - ${sections.length} page${sections.length === 1 ? "" : "s"}`);
  try {
    const result = await client.createNotebookFromSections(title, sections);
    stopGen();
    process.stdout.write(
      `  ${c.green("ok")} ${c.bold(result.title)} ${c.dim(`(${result.pageCount} page${result.pageCount === 1 ? "" : "s"}, ~${result.pageCount * V2_INK_PER_PAGE} Ink)`)}\n`,
    );
    process.stdout.write(`    ${c.brand(result.url)}\n\n`);
    if (opts.open) openInBrowser(result.url);
  } catch (e) {
    stopGen();
    process.stdout.write(`  ${c.red("x")} ${errMsg(e)}\n\n`);
  }
}

function deriveTitle(goal: string): string {
  const t = goal.replace(/^(plan|create|make|build|help me)\s+/i, "").trim();
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 60) || "Plan";
}
