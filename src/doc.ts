// `papera doc <files...>` — turn real documents into a faithful, multi-page
// Papera notebook.
//
// Unlike the lossy "summarize into one 1900-char prompt -> 1 page" path, this:
//   1. reads each file IN FULL (HTML is stripped to text), not truncated at 12k
//   2. estimates pages + Ink and shows the cost + WHY, then asks to confirm
//   3. splits the material into coherent sections (smart-by-size)
//   4. runs ONE v2 generation per section -> a single- or multi-page notebook
//
// Cost is transparent up front: generation is V2_INK_PER_PAGE Ink/page; the
// planning read is token-metered (charged by document size). Nothing is spent
// until the user confirms.

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  loadConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
} from "./config.js";
import { PaperaClient, PaperaError } from "./client.js";

// styling
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

// tuning (keep in sync with the backend economics)
const V2_INK_PER_PAGE = 10; // matches /api/generate-layout-v2
const CHAT_TOKENS_PER_INK = 100_000; // matches /api/chat metering
const MAX_DOC_CHARS = 60_000; // per file, after HTML->text
const MAX_TOTAL_CHARS = 240_000; // across all files (bounds planner cost)
const CHARS_PER_PAGE = 9_000; // raw distilled text -> ~1 page
const MAX_PAGES = 8; // hard cap so cost cannot run away

function startSpinner(text: string): () => void {
  const braille = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t0 = Date.now();
  const tick = () => {
    const el = Math.floor((Date.now() - t0) / 1000);
    const clk = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, "0")}`;
    process.stdout.write(`\r  ${c.brand(braille[(i = (i + 1) % braille.length)])} ${text} ${c.dim(clk)}   `);
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

// Light HTML -> text: drop script/style, strip tags, decode a few entities,
// collapse whitespace. Keeps the token spend (and cost) on real content.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface LoadedDoc {
  name: string;
  text: string;
  rawBytes: number;
}

function loadDocs(paths: string[]): LoadedDoc[] {
  const docs: LoadedDoc[] = [];
  let total = 0;
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) {
      process.stdout.write(`  ${c.yellow("!")} skipping ${c.bold(p)} - not found\n`);
      continue;
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      process.stdout.write(`  ${c.yellow("!")} skipping ${c.bold(p)} - is a directory\n`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      process.stdout.write(`  ${c.yellow("!")} skipping ${c.bold(p)} - unreadable\n`);
      continue;
    }
    // Binary sniff: a NUL byte in the head means it is not a text document.
    if (buf.subarray(0, 4000).includes(0)) {
      process.stdout.write(`  ${c.yellow("!")} skipping ${c.bold(p)} - looks binary\n`);
      continue;
    }
    const name = basename(abs);
    let text = /\.html?$/i.test(name) ? htmlToText(buf.toString("utf8")) : buf.toString("utf8");
    if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + "\n...[truncated]";
    if (total + text.length > MAX_TOTAL_CHARS) {
      text = text.slice(0, Math.max(0, MAX_TOTAL_CHARS - total)) + "\n...[truncated]";
    }
    if (text.trim().length === 0) continue;
    total += text.length;
    docs.push({ name, text, rawBytes: st.size });
    if (total >= MAX_TOTAL_CHARS) break;
  }
  return docs;
}

export interface DocOptions {
  pages?: string;
  title?: string;
  yes?: boolean;
  open?: boolean;
}

export async function runDoc(paths: string[], opts: DocOptions): Promise<void> {
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

  // 1. Read the documents (full, HTML->text, bounded).
  const docs = loadDocs(paths);
  if (docs.length === 0) {
    process.stdout.write(`  ${c.red("x")} No readable documents.\n\n`);
    return;
  }
  const totalChars = docs.reduce((n, d) => n + d.text.length, 0);
  const totalKB = Math.round(docs.reduce((n, d) => n + d.rawBytes, 0) / 1024);

  // 2. Estimate pages (smart-by-size) and Ink, BEFORE spending anything.
  const sizePages = Math.max(1, Math.round(totalChars / CHARS_PER_PAGE));
  const capPages = opts.pages ? Math.max(1, parseInt(opts.pages, 10) || 1) : MAX_PAGES;
  const estPages = Math.min(sizePages, capPages, MAX_PAGES);
  const readInk = Math.round(totalChars / 4 / CHAT_TOKENS_PER_INK); // token-metered planning read
  const genInk = estPages * V2_INK_PER_PAGE;
  const estInk = genInk + readInk;

  process.stdout.write(`\n  ${c.brandBold("papera doc")}\n`);
  for (const d of docs) {
    process.stdout.write(
      `  ${c.dim("-")} ${c.bold(d.name)} ${c.dim(`(${Math.round(d.rawBytes / 1024)} KB -> ${d.text.length.toLocaleString()} chars read)`)}\n`,
    );
  }
  process.stdout.write(
    `\n  ${c.bold("Plan")}: ~${estPages} page${estPages === 1 ? "" : "s"} ${c.dim(`(${totalKB} KB of content, split smart-by-size)`)}\n`,
  );
  process.stdout.write(
    `  ${c.bold("Ink")}:  ${c.brandBold(`~ ${estInk}`)} ${c.dim(`= ${genInk} generate (${estPages} x ${V2_INK_PER_PAGE}/page)${readInk ? ` + ~${readInk} reading` : ""}`)}\n`,
  );
  process.stdout.write(
    c.dim(`  Why: bigger / denser docs -> more sections -> more pages -> more Ink. Reading is token-metered.\n`),
  );

  // 3. Confirm before any spend (unless --yes).
  if (!opts.yes) {
    const ok = await confirm(
      `  ${c.dim("Generate this notebook for")} ${c.brandBold(`~ ${estInk} Ink`)}${c.dim("? [Y/n]")} `,
    );
    if (!ok) {
      process.stdout.write(c.dim("  okay, nothing generated.\n\n"));
      return;
    }
  }

  // 4. Plan sections (this is the metered reading spend).
  const combined = docs.map((d) => `### FILE: ${d.name}\n${d.text}`).join("\n\n");
  const stopPlan = startSpinner("reading & planning sections");
  let sections: { title: string; prompt: string }[];
  try {
    sections = await client.planDocSections(combined, estPages);
  } catch (e) {
    stopPlan();
    process.stdout.write(`  ${c.red("x")} ${errMsg(e)}\n\n`);
    return;
  }
  stopPlan();
  if (sections.length === 0) {
    process.stdout.write(`  ${c.red("x")} Planner produced no sections. Try again.\n\n`);
    return;
  }

  // 5. Generate one v2 page per section.
  const title = opts.title?.trim() || deriveTitle(docs);
  const total = sections.length;
  if (total !== estPages) {
    process.stdout.write(
      c.dim(`  (planner chose ${total} section${total === 1 ? "" : "s"} -> ${total * V2_INK_PER_PAGE} Ink to generate)\n`),
    );
  }
  const stopGen = startSpinner(`composing "${title}" - ${total} page${total === 1 ? "" : "s"}`);
  try {
    const result = await client.createNotebookFromSections(title, sections);
    stopGen();
    process.stdout.write(
      `  ${c.green("ok")} ${c.bold(result.title)} ${c.dim(`(${result.pageCount} page${result.pageCount === 1 ? "" : "s"}, ~${result.pageCount * V2_INK_PER_PAGE} Ink + reading)`)}\n`,
    );
    process.stdout.write(`    ${c.brand(result.url)}\n\n`);
    if (opts.open) openInBrowser(result.url);
  } catch (e) {
    stopGen();
    process.stdout.write(`  ${c.red("x")} ${errMsg(e)}\n`);
    if (e instanceof PaperaError && e.status === 402) {
      process.stdout.write(c.dim("  (ran out of Ink mid-generation - top up at papera.io/app)\n"));
    }
    process.stdout.write("\n");
  }
}

function deriveTitle(docs: LoadedDoc[]): string {
  if (docs.length === 1) return docs[0].name.replace(/\.[^.]+$/, "");
  return "Document Notebook";
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
