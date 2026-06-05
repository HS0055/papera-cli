// `papera connections` — show the user's connected MCP servers and their
// tools. This is the visible proof of Path B: the CLI reaches the user's own
// MCP servers (calendar, bank, …) using the auth that lives in THOSE servers.

import { loadMcpServers, listServerTools, MCP_CONFIG_PATH } from "./mcp-client.js";

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

function printSetupHelp(): void {
  process.stdout.write(
    `\n  ${c.yellow("No MCP servers connected.")}\n` +
      `  Add your servers (calendar, bank, anything) to ${c.bold(MCP_CONFIG_PATH)} —\n` +
      `  same format as Claude Desktop:\n\n` +
      c.dim(
        `  {\n` +
          `    "mcpServers": {\n` +
          `      "calendar": { "command": "npx", "args": ["-y", "<calendar-mcp>"], "env": { "…": "…" } },\n` +
          `      "bank":     { "command": "npx", "args": ["-y", "<bank-mcp>"] }\n` +
          `    }\n` +
          `  }\n`,
      ) +
      `\n  Auth lives in those servers — Papera reuses it, stores no keys.\n` +
      `  Then run ${c.bold("papera chat")} and ask e.g. "fill my Exercise row from this week's calendar".\n\n`,
  );
}

export async function runConnections(): Promise<void> {
  const servers = loadMcpServers();
  const names = Object.keys(servers);
  if (names.length === 0) {
    printSetupHelp();
    return;
  }

  process.stdout.write(`\n  ${c.brandBold("Connected MCP servers")} ${c.dim(`(${MCP_CONFIG_PATH})`)}\n`);
  for (const name of names) {
    const spec = servers[name];
    process.stdout.write(`\n  ${c.brand("●")} ${c.bold(name)} ${c.dim(`— ${spec.command} ${(spec.args ?? []).join(" ")}`)}\n`);
    process.stdout.write(c.dim(`      connecting…`));
    let tools;
    try {
      tools = await listServerTools(name, spec);
    } catch (e) {
      process.stdout.write(`\r      ${c.red("✖ could not connect:")} ${(e as Error).message}\n`);
      continue;
    }
    process.stdout.write(`\r              \r`);
    if (tools.length === 0) {
      process.stdout.write(c.dim("      (no tools)\n"));
      continue;
    }
    for (const t of tools) {
      const desc = (t.description ?? "").replace(/\s+/g, " ").slice(0, 70);
      process.stdout.write(`      ${c.bold(t.name)}${desc ? `  ${c.dim(desc)}` : ""}\n`);
    }
  }
  process.stdout.write(
    `\n  ${c.dim("Use these in")} ${c.bold("papera chat")} ${c.dim('— e.g. "fill my tracker from my calendar".')}\n\n`,
  );
}
