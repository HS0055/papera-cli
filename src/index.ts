// Papera SDK — programmatic access to the Papera API.
//
//   import { PaperaClient } from "papera";
//   const papera = new PaperaClient({
//     apiUrl: "https://veracious-pony-145.convex.site",
//     appUrl: "https://papera.io",
//     apiKey: process.env.PAPERA_API_KEY,
//   });
//   const { url } = await papera.createPageFromPrompt("weekly meal planner");
//
// The CLI (`papera`) and the MCP server (`papera mcp`) are thin consumers of
// this same client.

export { PaperaClient, PaperaError } from "./client.js";
export type {
  GeneratedLayout,
  NotebookSummary,
  RemotePage,
  RemoteNotebook,
  CreatePageResult,
  PaperaClientOptions,
} from "./client.js";

export {
  loadConfig,
  saveConfig,
  resolveApiKey,
  resolveApiUrl,
  resolveAppUrl,
  resolveGeminiKey,
  resolveGithubToken,
  resolveOpenaiKey,
  CONFIG_PATH,
} from "./config.js";
export type { PaperaConfig } from "./config.js";

// Tracker primitives (read/write a notebook's habit table-tracker).
export {
  findTracker,
  resolveRow,
  resolveColumn,
  applyCells,
} from "./trackers.js";
export type { TrackerHit } from "./trackers.js";
