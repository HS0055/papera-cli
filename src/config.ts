// Config + credential resolution for the Papera CLI / MCP server.
//
// Precedence for every resolved value: environment variable → ~/.papera/config.json
// → built-in production default. This lets MCP hosts (Claude Desktop, Cursor)
// inject PAPERA_API_KEY via env without a login step, while the human CLI uses
// the stored config written by `papera login`.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";

// Production deployment. The Papera backend is Convex HTTP actions served at
// the deployment's .convex.site origin; notebooks are opened in the web app.
const DEFAULT_API_URL = "https://veracious-pony-145.convex.site";
const DEFAULT_APP_URL = "https://papera.io";

export interface PaperaConfig {
  /** Long-lived API key (papera_live_…). */
  apiKey?: string;
  /** Override the backend HTTP base. */
  apiUrl?: string;
  /** Override the web app origin used to build open URLs. */
  appUrl?: string;
  /** Stored for display only ("Logged in as …"). */
  email?: string;
  /** Gemini API key powering `papera chat` (the agentic console). */
  geminiKey?: string;
  /** GitHub token for `papera sync --from github` (read-only). */
  githubToken?: string;
  /** OpenAI API key powering `papera plan` (client-side planning brain). */
  openaiKey?: string;
}

const CONFIG_DIR = join(homedir(), ".papera");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): PaperaConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as PaperaConfig;
    }
  } catch {
    // Corrupt/unreadable config → treat as empty; `papera login` rewrites it.
  }
  return {};
}

export function saveConfig(cfg: PaperaConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // 0600 — the file holds a credential. Write then chmod (umask can widen the
  // initial mode on some platforms).
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Best effort (e.g. Windows) — non-fatal.
  }
}

export function resolveApiUrl(cfg: PaperaConfig): string {
  return process.env.PAPERA_API_URL || cfg.apiUrl || DEFAULT_API_URL;
}

export function resolveAppUrl(cfg: PaperaConfig): string {
  return process.env.PAPERA_APP_URL || cfg.appUrl || DEFAULT_APP_URL;
}

export function resolveApiKey(cfg: PaperaConfig): string | undefined {
  const key = process.env.PAPERA_API_KEY || cfg.apiKey;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

export function resolveGeminiKey(cfg: PaperaConfig): string | undefined {
  const key =
    process.env.PAPERA_GEMINI_KEY || process.env.GEMINI_API_KEY || cfg.geminiKey;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

export function resolveGithubToken(cfg: PaperaConfig): string | undefined {
  const key =
    process.env.GITHUB_TOKEN || process.env.PAPERA_GITHUB_TOKEN || cfg.githubToken;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

export function resolveOpenaiKey(cfg: PaperaConfig): string | undefined {
  const key =
    process.env.PAPERA_OPENAI_KEY || process.env.OPENAI_API_KEY || cfg.openaiKey;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}
