// `papera sync <notebook> --from github` — the first "living tracker" connector.
//
// Reads a notebook's habit `table-tracker`, pulls your GitHub contribution
// activity for the current week, and CHECKS the cells of a "code"/"commit" row
// for the days you were active — then writes it back via save-sync. The grid's
// cell model is props.cells[row][col]: 0=empty, 1=partial, 2=full.
//
// Auth: GITHUB_TOKEN (read-only) from the environment → GraphQL contributions
// calendar (includes private repos). No token → public Events API (needs --user).
// The token never appears in chat or any argument; it's read from the env only.

import {
  loadConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
  resolveGithubToken,
} from "./config.js";
import { PaperaClient, PaperaError, type RemoteNotebook } from "./client.js";

const C = "\x1b[";
const R = C + "0m";
const s = {
  bold: (t: string) => `${C}1m${t}${R}`,
  dim: (t: string) => `${C}2m${t}${R}`,
  green: (t: string) => `${C}32m${t}${R}`,
  red: (t: string) => `${C}31m${t}${R}`,
  brand: (t: string) => `${C}38;2;129;140;248m${t}${R}`,
};

const CODE_ROW_RE = /\b(code|coding|commit|git|github|dev|develop|program|build|ship|pr|hack)\b/i;

/** ISO dates Mon→Sun for the week containing today (UTC). */
function currentWeekDates(now: Date): string[] {
  const dow = (now.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setUTCDate(mon.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Map of ISO-date → contribution/commit count, for the given week. */
async function fetchGithubDays(
  token: string | undefined,
  user: string | undefined,
  weekDates: string[],
): Promise<{ days: Record<string, number>; login: string; source: string }> {
  if (token) {
    const from = `${weekDates[0]}T00:00:00Z`;
    const to = `${weekDates[6]}T23:59:59Z`;
    const query = `query($from:DateTime!,$to:DateTime!){viewer{login contributionsCollection(from:$from,to:$to){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`;
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "papera-cli" },
      body: JSON.stringify({ query, variables: { from, to } }),
    });
    const j: any = await res.json();
    if (j.errors) throw new Error(`GitHub GraphQL: ${j.errors[0]?.message ?? "error"}`);
    if (j.message) throw new Error(`GitHub: ${j.message}`);
    const days: Record<string, number> = {};
    const weeks = j?.data?.viewer?.contributionsCollection?.contributionCalendar?.weeks ?? [];
    for (const w of weeks) for (const d of w.contributionDays) days[d.date] = d.contributionCount;
    return { days, login: j?.data?.viewer?.login ?? "you", source: "contributions (incl. private)" };
  }

  if (!user) {
    throw new PaperaError(
      "No GITHUB_TOKEN set. Either `export GITHUB_TOKEN=<read-only PAT>` (recommended — sees private commits), or pass --user <github-username> for public commits only.",
      401,
      "no_github_auth",
    );
  }
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "papera-cli" },
  });
  const j: any = await res.json();
  if (j.message) throw new Error(`GitHub: ${j.message}`);
  const days: Record<string, number> = {};
  for (const e of Array.isArray(j) ? j : []) {
    if (e.type !== "PushEvent") continue;
    const d = String(e.created_at).slice(0, 10);
    days[d] = (days[d] ?? 0) + (e.payload?.commits?.length ?? 1);
  }
  return { days, login: user, source: "public push events" };
}

type Tracker = {
  el: any; // the element carrying widgetConfig (mutated in place)
  rows: { label?: string }[];
  columns: number;
  columnLabels: string[];
};

function findTableTracker(nb: RemoteNotebook): { tracker: Tracker; pageIndex: number } | null {
  for (let pi = 0; pi < nb.pages.length; pi++) {
    const found = walkForTracker((nb.pages[pi] as any).elements ?? []);
    if (found) return { tracker: found, pageIndex: pi };
  }
  return null;
}

function walkForTracker(els: any[]): Tracker | null {
  for (const el of els) {
    const cfg = el?.widgetConfig;
    if (cfg?.widgetType === "table-tracker") {
      const p = cfg.props ?? {};
      return {
        el,
        rows: Array.isArray(p.rows) ? p.rows : [],
        columns: typeof p.columns === "number" ? p.columns : (p.columnLabels?.length ?? 7),
        columnLabels: Array.isArray(p.columnLabels) ? p.columnLabels : [],
      };
    }
    if (Array.isArray(el?.children)) {
      const r = walkForTracker(el.children);
      if (r) return r;
    }
  }
  return null;
}

export interface SyncOptions {
  notebook: string; // id or title
  source: string; // "github"
  row?: string;
  user?: string;
  dryRun?: boolean;
}

export async function runGithubSync(opts: SyncOptions): Promise<void> {
  const cfg = loadConfig();
  const client = new PaperaClient({
    apiUrl: resolveApiUrl(cfg),
    appUrl: resolveAppUrl(cfg),
    apiKey: resolveApiKey(cfg),
  });
  const token = resolveGithubToken(cfg);

  // 1. Resolve the notebook (by id, else case-insensitive title match).
  const notebooks = await client.fetchNotebooks();
  const target =
    notebooks.find((n) => n.id === opts.notebook) ??
    notebooks.find((n) => n.title.toLowerCase() === opts.notebook.toLowerCase()) ??
    notebooks.find((n) => n.title.toLowerCase().includes(opts.notebook.toLowerCase()));
  if (!target) {
    throw new PaperaError(`No notebook matching "${opts.notebook}". Try \`papera list\`.`, 404);
  }

  // 2. Find a table-tracker.
  const hit = findTableTracker(target);
  if (!hit) {
    throw new PaperaError(
      `"${target.title}" has no habit table-tracker to sync. Generate one with a "Code" habit first (e.g. papera new "weekly habit tracker for coding, exercise, reading").`,
      422,
    );
  }
  const { tracker } = hit;
  const cols = tracker.columns;

  // 3. Pick the row to fill.
  let rowIndex = opts.row
    ? tracker.rows.findIndex((r) => (r.label ?? "").toLowerCase().includes(opts.row!.toLowerCase()))
    : tracker.rows.findIndex((r) => CODE_ROW_RE.test(r.label ?? ""));
  if (rowIndex < 0) {
    const labels = tracker.rows.map((r, i) => `${i + 1}. ${r.label ?? "?"}`).join("   ");
    throw new PaperaError(
      opts.row
        ? `No row matching "${opts.row}". Rows: ${labels}`
        : `Couldn't auto-find a code/commit row. Pass --row <label>. Rows: ${labels}`,
      422,
    );
  }
  const rowLabel = tracker.rows[rowIndex].label ?? `row ${rowIndex + 1}`;

  // 4. Fetch GitHub activity for the current week.
  const weekDates = currentWeekDates(new Date());
  const { days, login, source } = await fetchGithubDays(token, opts.user, weekDates);

  // 5. Map dates → columns (Mon→Sun). col i active when count>0.
  const activeCols: number[] = [];
  const perDay: string[] = [];
  for (let i = 0; i < Math.min(cols, 7); i++) {
    const count = days[weekDates[i]] ?? 0;
    perDay.push(`${(tracker.columnLabels[i] ?? "?")}=${count > 0 ? "✓" : "·"}`);
    if (count > 0) activeCols.push(i);
  }

  process.stdout.write(
    `\n  ${s.brand("github")} ${s.dim(`(${login}, ${source})`)}\n` +
      `  ${s.dim("notebook:")} ${s.bold(target.title)}   ${s.dim("row:")} ${s.bold(rowLabel)}\n` +
      `  ${s.dim("week:")} ${weekDates[0]} → ${weekDates[6]}\n` +
      `  ${s.dim("days:")} ${perDay.join("  ")}\n` +
      `  ${s.bold(`${activeCols.length}/${Math.min(cols, 7)}`)} active days\n`,
  );

  if (opts.dryRun) {
    process.stdout.write(s.dim("\n  (dry run — nothing written)\n\n"));
    return;
  }

  // 6. Mutate props.cells[rowIndex][col] = 2 for active days.
  const props = (tracker.el.widgetConfig.props ??= {});
  const grid: number[][] = Array.isArray(props.cells)
    ? props.cells.map((r: any) => (Array.isArray(r) ? r.slice() : []))
    : [];
  while (grid.length < tracker.rows.length) grid.push([]);
  const row = grid[rowIndex] ?? [];
  while (row.length < cols) row.push(0);
  for (const ci of activeCols) row[ci] = 2;
  grid[rowIndex] = row;
  props.cells = grid;

  // 7. Write the full notebook back (all pages preserved).
  await client.saveNotebook({
    id: target.id,
    title: target.title,
    coverColor: target.coverColor,
    bookmarks: target.bookmarks ?? [],
    pages: target.pages as unknown[],
  });

  process.stdout.write(
    `  ${s.green("✓")} checked ${s.bold(String(activeCols.length))} day(s) in "${rowLabel}".\n` +
      `    ${s.brand(client.notebookUrl(target.id))}\n\n`,
  );
}
