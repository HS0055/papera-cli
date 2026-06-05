// Path B — Papera CLI as an MCP *client*.
//
// The user lists their own MCP servers (calendar, bank, anything) in
// ~/.papera/mcp.json — SAME format as Claude Desktop / Cursor. Auth lives in
// THOSE servers (their keys/OAuth), so the CLI reuses the user's existing
// connections with zero Papera-side credentials. This module connects to them
// over stdio, lists their tools, and calls them.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const MCP_CONFIG_PATH = join(homedir(), ".papera", "mcp.json");

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Load the user's MCP server map from ~/.papera/mcp.json ({ mcpServers: {…} }). */
export function loadMcpServers(): Record<string, McpServerSpec> {
  try {
    if (existsSync(MCP_CONFIG_PATH)) {
      const j = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8"));
      const servers = j?.mcpServers ?? j ?? {};
      return servers && typeof servers === "object" ? servers : {};
    }
  } catch {
    /* malformed config → treat as none */
  }
  return {};
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

// A clean string env (StdioClientTransport's default env is minimal; we pass
// the real PATH/HOME so user servers launched via npx/node actually start).
function fullEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

async function withClient<T>(spec: McpServerSpec, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: fullEnv(spec.env),
  });
  const client = new Client({ name: "papera-cli", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Connect to one server and list its tools. */
export async function listServerTools(name: string, spec: McpServerSpec): Promise<McpToolInfo[]> {
  return withClient(spec, async (c) => {
    const res = await c.listTools();
    return (res.tools ?? []).map((t) => ({
      server: name,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  });
}

/** List tools across ALL configured servers (best-effort; failures noted). */
export async function listAllTools(): Promise<{
  tools: McpToolInfo[];
  errors: { server: string; error: string }[];
}> {
  const servers = loadMcpServers();
  const tools: McpToolInfo[] = [];
  const errors: { server: string; error: string }[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    try {
      tools.push(...(await listServerTools(name, spec)));
    } catch (e) {
      errors.push({ server: name, error: (e as Error)?.message ?? String(e) });
    }
  }
  return { tools, errors };
}

/** Call a tool on a named server; returns the joined text content. */
export async function callServerTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const servers = loadMcpServers();
  const spec = servers[server];
  if (!spec) throw new Error(`No MCP server named "${server}" in ${MCP_CONFIG_PATH}`);
  return withClient(spec, async (c) => {
    const res = (await c.callTool({ name: tool, arguments: args ?? {} })) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = res?.content ?? [];
    return content.map((p) => (p?.type === "text" ? p.text ?? "" : JSON.stringify(p))).join("\n");
  });
}
