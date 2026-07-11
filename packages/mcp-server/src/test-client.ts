#!/usr/bin/env node
/**
 * Standalone harness to verify the full pipe (MCP client -> mcp-server ->
 * WS -> extension -> content scripts -> ChartIQ engine) without needing
 * Claude Code in the loop. Spawns the built server as a child process over
 * stdio, exactly like a real MCP client would.
 *
 * Why it POLLS instead of calling once: the extension's MV3 background
 * service worker is event-driven and gets suspended when idle, and it can
 * only connect to the WS server while that server is actually listening.
 * A fire-once call almost always races ahead of the extension connecting.
 * So we keep the (long-lived, like a real MCP session) server up and retry
 * `get_chart_data` every couple seconds, printing what's currently blocking,
 * until it succeeds or we give up. This lets you start this command first and
 * THEN do the browser setup (load/reload the extension, open a chart tab).
 *
 * Usage: build everything first (`npm run build`), then:
 *   npm run test:loop
 * ...and while it's waiting, in Chrome: make sure the unpacked extension is
 * loaded, open a Yahoo Finance chart tab (e.g. .../quote/AAPL/chart) and
 * keep it focused. If it says "extension not connected", reload the
 * extension in chrome://extensions to wake its service worker.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "index.js");

const OVERALL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull the embedded ToolResponse envelope out of an MCP tool result. */
function parseEnvelope(result: unknown): {
  ok?: boolean;
  error_code?: string;
  message?: string;
  symbol?: string | null;
  data?: unknown;
} | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  const text = content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Human-readable hint for each "still not ready" state. */
function hintFor(errorCode: string | undefined): string {
  switch (errorCode) {
    case "NO_TAB":
      return "extension not connected — is it loaded? try reloading it in chrome://extensions to wake its service worker";
    case "NOT_CHART_PAGE":
      return "extension connected, but no Yahoo chart tab found — open .../quote/AAPL/chart (or call open_chart) and keep it focused";
    case "ENGINE_NOT_FOUND":
      return "on a Yahoo tab, but the ChartIQ engine isn't attached yet — let the chart finish loading";
    case "ENGINE_IN_IFRAME":
      return "the chart appears sealed inside an iframe/shadow root the extension can't reach — Yahoo may have changed its embed";
    case "DATA_NOT_READY":
      return "engine found, but no bars loaded yet — give the chart a moment to render data";
    case "NOT_READY":
      return "the chart tab's content script isn't ready yet (page still loading) — retrying";
    case "TIMEOUT":
      return "request timed out reaching the page — retrying";
    default:
      return errorCode ?? "unknown";
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
  });

  const client = new Client({ name: "tratto-test-client", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("Available tools:", tools.map((t) => t.name).join(", "));

  console.log(
    "\nWaiting for the full pipe to come up (extension + Yahoo chart tab)...\n" +
      "Start/reload the unpacked extension and open a Yahoo chart tab now.\n",
  );

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let lastHint = "";

  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: "get_chart_data",
      arguments: { last_n: 50 },
    });
    const env = parseEnvelope(result);

    if (env?.ok) {
      console.log("\n✅ Pipe is working. get_chart_data returned:");
      console.log(JSON.stringify(result, null, 2));
      await client.close();
      process.exit(0);
    }

    const hint = hintFor(env?.error_code);
    if (hint !== lastHint) {
      console.log(`… ${hint}`);
      lastHint = hint;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error("\n❌ Gave up after 120s — the pipe never came up. Last state:", lastHint);
  await client.close();
  process.exit(1);
}

main().catch((err) => {
  console.error("[test-client] failed:", err);
  process.exit(1);
});
