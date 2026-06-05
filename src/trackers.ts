// Shared primitives for reading & writing a notebook's habit `table-tracker`
// widget. Used by the MCP write tools (papera_get_tracker / papera_update_tracker)
// so ANY MCP host — with a calendar, bank, GitHub, etc. server connected — can
// push real data into a Papera "living tracker" with no Papera-side auth.
//
// Cell model (matches the web widget): props.cells[row][col] is 0=empty,
// 1=partial, 2=full. Rows come from props.rows[].label; columns from
// props.columns (+ optional props.columnLabels).

import type { RemoteNotebook } from "./client.js";

export interface TrackerHit {
  /** The element carrying widgetConfig — mutate its props in place, then save. */
  el: any;
  pageIndex: number;
  rows: string[];
  columns: number;
  columnLabels: string[];
  cells: number[][];
}

function walk(els: any[]): any | null {
  for (const el of els || []) {
    const cfg = el?.widgetConfig;
    if (cfg?.widgetType === "table-tracker") return el;
    if (Array.isArray(el?.children)) {
      const found = walk(el.children);
      if (found) return found;
    }
  }
  return null;
}

/** Find the first table-tracker across a notebook's pages, or null. */
export function findTracker(nb: RemoteNotebook): TrackerHit | null {
  const pages = nb.pages || [];
  for (let pi = 0; pi < pages.length; pi++) {
    const el = walk((pages[pi] as any).elements ?? []);
    if (!el) continue;
    const p = el.widgetConfig.props ?? {};
    const rows = (Array.isArray(p.rows) ? p.rows : []).map((r: any) => String(r?.label ?? "?"));
    const columnLabels = Array.isArray(p.columnLabels) ? p.columnLabels.map(String) : [];
    const columns = typeof p.columns === "number" ? p.columns : columnLabels.length || 7;
    const cells = Array.isArray(p.cells) ? (p.cells as number[][]) : [];
    return { el, pageIndex: pi, rows, columns, columnLabels, cells };
  }
  return null;
}

/** Resolve a row by label (case-insensitive substring) or 1-based number. -1 if none. */
export function resolveRow(hit: TrackerHit, row: string): number {
  const t = String(row).trim();
  if (/^\d+$/.test(t)) {
    const idx = parseInt(t, 10) - 1;
    return idx >= 0 && idx < hit.rows.length ? idx : -1;
  }
  const lo = t.toLowerCase();
  return hit.rows.findIndex((r) => r.toLowerCase().includes(lo));
}

/** Resolve a column by 0-based index or label (exact, else substring). -1 if none. */
export function resolveColumn(hit: TrackerHit, column: number | string): number {
  if (typeof column === "number") return column >= 0 && column < hit.columns ? Math.floor(column) : -1;
  const t = String(column).trim();
  if (/^\d+$/.test(t)) {
    const i = parseInt(t, 10);
    return i >= 0 && i < hit.columns ? i : -1;
  }
  const lo = t.toLowerCase();
  let i = hit.columnLabels.findIndex((l) => l.toLowerCase() === lo);
  if (i < 0) i = hit.columnLabels.findIndex((l) => l.toLowerCase().includes(lo));
  return i;
}

/** Mutate the tracker's cells grid in place: set [rowIndex][col] = clamped state. */
export function applyCells(
  hit: TrackerHit,
  rowIndex: number,
  updates: { col: number; state: number }[],
): void {
  if (!hit.el.widgetConfig.props) hit.el.widgetConfig.props = {};
  const props = hit.el.widgetConfig.props;
  const grid: number[][] = Array.isArray(props.cells)
    ? props.cells.map((r: any) => (Array.isArray(r) ? r.slice() : []))
    : [];
  while (grid.length < hit.rows.length) grid.push([]);
  const rowArr = grid[rowIndex] ?? [];
  while (rowArr.length < hit.columns) rowArr.push(0);
  for (const u of updates) {
    if (u.col >= 0 && u.col < hit.columns) {
      rowArr[u.col] = Math.max(0, Math.min(2, Math.floor(u.state)));
    }
  }
  grid[rowIndex] = rowArr;
  props.cells = grid;
}
