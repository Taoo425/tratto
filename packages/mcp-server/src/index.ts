#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { startWsServer } from "./ws-server.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const bridge = new Bridge();

  let closeWs: () => void;
  try {
    closeWs = await startWsServer(bridge);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Fast-fail per spec: never silently pick another port. A second
      // instance almost certainly means the user already has one running.
      console.error(
        "[mcp-server] another mcp-server instance already owns port 8787 — a second one can't start.",
      );
    } else {
      console.error("[mcp-server] failed to start WebSocket server:", err);
    }
    process.exit(1);
  }

  // The WS http listener keeps the Node event loop alive on its own — without
  // an explicit close, the process (and port 8787) outlives the MCP stdio
  // pipe, orphaning it and causing the next start to hit EADDRINUSE for no
  // visible reason.
  const shutdown = () => {
    try {
      closeWs();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown); // MCP stdio pipe closed (agent/session ended)

  const server = new McpServer({ name: "tratto", version: "0.1.0" });
  registerTools(server, bridge);

  // stdio is the MCP transport to the coding agent (Claude Code/Codex); the
  // WS server above is a separate, unrelated transport to the extension.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-server] MCP server connected over stdio");
}

main().catch((err) => {
  console.error("[mcp-server] fatal:", err);
  process.exit(1);
});
