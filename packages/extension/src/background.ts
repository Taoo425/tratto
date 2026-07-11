/**
 * MV3 background service worker. Owns the single WebSocket connection OUT to
 * the local mcp-server (browsers can't accept inbound connections, so the
 * extension has to dial the server, not the other way around).
 *
 * Deliberately holds NO reference to the ChartIQ engine or any per-tab
 * state beyond routing — every tool request re-resolves its target tab and
 * the content-main script re-queries the engine fresh each time.
 */
import {
  SHARED_TOKEN,
  WS_PORT,
  makeError,
  type ToolRequest,
  type ToolResponse,
  type ProbeReadyResult,
  type OpenChartResult,
} from "@tratto/shared";
import type { ChartStatus, GetStatusResult, PopupToBackgroundMessage } from "./popup-types";

const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const PING_INTERVAL_MS = 20000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * The keepalive/recovery strategy has TWO layers, because an MV3 service
 * worker gets suspended after ~30s idle and plain setInterval/setTimeout do
 * NOT fire (and cannot revive it) once it's asleep:
 *  1. While alive: a 20s setInterval ping (below 30s) resets the idle timer,
 *     so in practice the worker never reaches the suspension threshold.
 *  2. As a safety net: a chrome.alarms alarm. Alarms are the only timer that
 *     can WAKE a suspended worker — when it fires we reconnect (or ping) so
 *     the socket recovers even if the worker did get killed. 0.5 min is the
 *     platform minimum for alarm periods.
 */
const KEEPALIVE_ALARM = "tratto-keepalive";
const KEEPALIVE_ALARM_PERIOD_MIN = 0.5;

const YAHOO_CHART_URL_PATTERN = /^https:\/\/finance\.yahoo\.com\/(quote\/[^/]+\/chart|chart\/)/;

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks "has the WS ever reached OPEN at least once this worker lifetime",
// purely for the popup/badge distinction between "never configured" (grey,
// quiet) and "was connected, just dropped" (red badge, worth shouting about).
let everConnected = false;

function log(...args: unknown[]): void {
  console.log("[tratto-background]", ...args);
}

/**
 * Idempotent "make sure we have a live socket" entry point. Called on worker
 * startup and on every keepalive alarm. If the socket is gone/closing it
 * (re)connects; if it's open it sends a ping to reset the idle timer.
 */
function ensureConnected(): void {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    connect();
  } else if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      // If the send throws the socket is effectively dead; force a reconnect.
      connect();
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  log(`reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function startPing(ws: WebSocket): void {
  stopPing();
  // The extension drives keepalive pings (rather than relying on the server)
  // because the MV3 service worker is the thing that gets killed when idle;
  // a periodic outbound send is also our own liveness signal for the socket.
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, PING_INTERVAL_MS);
}

/**
 * Toolbar badge: stay quiet when things are fine (never-connected first boot,
 * or healthy), only shout when a connection that was working just dropped —
 * that's the actionable state ("something broke"), not "hasn't been set up
 * yet" (that's what the popup's first-run config block is for).
 */
function updateBadge(): void {
  const isDroppedConnection = everConnected && socket?.readyState !== WebSocket.OPEN;
  if (isDroppedConnection) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function connect(): void {
  // Guard against spawning a second socket when one is already coming up or
  // live (ensureConnected can be driven concurrently by startup + alarm).
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }
  log(`connecting to ${WS_URL}`);
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.addEventListener("open", () => {
    log("connected, sending hello");
    reconnectAttempt = 0;
    everConnected = true;
    ws.send(JSON.stringify({ type: "hello", token: SHARED_TOKEN }));
    startPing(ws);
    updateBadge();
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    void handleServerMessage(ws, event.data);
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return; // a superseded/old socket closing — ignore it entirely
    log("socket closed");
    socket = null;
    stopPing();
    scheduleReconnect();
    updateBadge();
  });

  ws.addEventListener("error", (err) => {
    // HARMLESS / EXPECTED — safe to ignore.
    // When the local mcp-server isn't running (i.e. Claude Code isn't actively
    // using this extension), this dial is refused and the BROWSER ITSELF logs a
    // red "WebSocket connection to 'ws://127.0.0.1:8787/' failed:
    // net::ERR_CONNECTION_REFUSED" to the console — which also surfaces under the
    // extension card's "Errors" button in chrome://extensions. That is NOT a bug:
    // the extension is a client that has to keep dialing the server until it comes
    // up. The browser emits that line before our code ever runs, so it CANNOT be
    // caught or suppressed from JavaScript (try/catch here does nothing about it).
    // Nothing is broken — the socket simply reconnects (handled in "close" below,
    // which fires right after "error") and everything works the moment the server
    // is up. If the red line bothers you, click "Clear all" in the Errors panel;
    // it only comes back while the server is down. Our own log stays at info level
    // (console.log, not console.error) so we don't add to that Errors count.
    log("socket error (expected & harmless when the mcp-server isn't running yet)", err);
    // "close" fires after "error" for WebSocket, so reconnect scheduling is
    // handled there; nothing further to do here.
  });
}

async function handleServerMessage(ws: WebSocket, raw: unknown): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  if ((msg as { type?: unknown }).type === "pong") {
    return; // liveness ack only
  }

  if (!isToolRequest(msg)) return;

  const response = await routeToolRequest(msg);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

function isToolRequest(value: unknown): value is ToolRequest {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ToolRequest).id === "string" &&
    typeof (value as ToolRequest).tool === "string" &&
    typeof (value as ToolRequest).params === "object"
  );
}

/** Finds the active Yahoo chart tab in the last-focused normal window. */
async function findTargetTab(): Promise<chrome.tabs.Tab | null> {
  const windows = await chrome.windows.getAll({ populate: false, windowTypes: ["normal"] });
  // Deliberately no `?? windows[0]` fallback here: guessing at an arbitrary
  // (non-focused) window's active tab can silently target the wrong tab if
  // no window happens to be focused. Fall through to the Yahoo-tab-anywhere
  // search below instead.
  const focused = windows.find((w) => w.focused);
  if (focused?.id) {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: focused.id });
    if (activeTab?.url && YAHOO_CHART_URL_PATTERN.test(activeTab.url)) {
      return activeTab;
    }
  }

  // Fall back to any Yahoo chart tab anywhere, in case the active tab in the
  // focused window isn't the chart (e.g. user is tabbed away momentarily).
  const candidates = await chrome.tabs.query({ url: "https://finance.yahoo.com/*" });
  return candidates.find((t) => t.url && YAHOO_CHART_URL_PATTERN.test(t.url)) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Programmatically (re)inject the content scripts into a tab. Chrome already
 * injects them declaratively on a normal load, but that misses two cases:
 *  - the tab was open BEFORE the extension loaded/reloaded (the classic "must
 *    refresh once to connect" bug), and
 *  - a tab we're reusing that's already on the exact target URL (tabs.update
 *    to the same URL may not trigger a reload).
 * Both content scripts guard against double-install, so re-injecting an
 * already-present script is a harmless no-op.
 */
async function injectContentScripts(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-isolated.js"] });
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content-main.js"] });
}

interface ReadySnapshot {
  url: string;
  engine_present: boolean;
  data_set_len: number;
  in_iframe: boolean;
}

/** Send a one-shot readiness probe to the tab's content script. */
async function sendProbe(tabId: number): Promise<ToolResponse | null> {
  try {
    const req: ToolRequest = { id: crypto.randomUUID(), tool: "probe_ready", params: {} };
    const res = (await chrome.tabs.sendMessage(tabId, req)) as ToolResponse | undefined;
    return res ?? null;
  } catch {
    return null; // no content script listening (yet) on this tab
  }
}

/** Extracts a ticker symbol from a Yahoo chart tab URL, uppercased. */
function extractSymbolFromUrl(url: string): string | null {
  const quoteMatch = url.match(/\/quote\/([^/]+)\/chart/i);
  if (quoteMatch?.[1]) return decodeURIComponent(quoteMatch[1]).toUpperCase();
  const chartMatch = url.match(/\/chart\/([^/?#]+)/i);
  if (chartMatch?.[1]) return decodeURIComponent(chartMatch[1]).toUpperCase();
  return null;
}

/**
 * True if the probed page is actually showing the symbol we navigated to. This
 * guards the cross-symbol reuse race: when we navigate an existing AAPL chart
 * tab to NVDA, the old AAPL document (engine + populated dataSet still attached)
 * can answer the very first probe before the navigation commits. Without this
 * check we'd declare the chart "ready" on stale AAPL data. We match on the URL
 * path segment (survives redirects/query params) or the engine's own symbol.
 */
function probeMatchesSymbol(snapshot: ReadySnapshot, symbol: string): boolean {
  const s = symbol.toLowerCase();
  const url = snapshot.url.toLowerCase();
  return url.includes(`/chart/${s}`) || url.includes(`/quote/${s}/`);
}

/**
 * Poll a freshly-navigated tab until the ChartIQ engine is attached AND its
 * dataSet is populated, injecting the content scripts once if they're missing.
 * This is the tab-level half of the ready-wait shared piece (the in-page half
 * lives in content-main's waitForChartReady). Resolves with the final
 * readiness snapshot either way — never throws, never hangs past the deadline.
 */
async function waitForTabChartReady(
  tabId: number,
  symbol: string,
  timeoutMs: number,
): Promise<{ ready: boolean; injected: boolean; snapshot: ReadySnapshot }> {
  const deadline = Date.now() + timeoutMs;
  let injected = false;
  const snapshot: ReadySnapshot = { url: "", engine_present: false, data_set_len: 0, in_iframe: false };

  while (Date.now() < deadline) {
    const res = await sendProbe(tabId);
    if (!res) {
      // Content script not reachable. Once the document has finished loading,
      // inject once to cover the stale-extension / same-URL-reuse cases.
      let status = "";
      try {
        const t = await chrome.tabs.get(tabId);
        status = t.status ?? "";
        if (t.url) snapshot.url = t.url;
      } catch {
        /* tab may be mid-navigation */
      }
      if (status === "complete" && !injected) {
        try {
          await injectContentScripts(tabId);
        } catch {
          /* page not injectable yet; retry loop will try the probe again */
        }
        injected = true;
      }
      await sleep(400);
      continue;
    }
    if (res.ok && res.data) {
      const d = res.data as ProbeReadyResult;
      snapshot.url = d.url;
      snapshot.engine_present = d.engine_present;
      snapshot.data_set_len = d.data_set_len;
      snapshot.in_iframe = d.in_iframe;
      // Require the engine, a populated dataSet, AND that the page is really on
      // the requested symbol — otherwise a stale pre-navigation document answers
      // "ready" on the previous symbol's data (the cross-symbol reuse race).
      if (d.engine_present && d.data_set_len > 0 && probeMatchesSymbol(snapshot, symbol)) {
        return { ready: true, injected, snapshot };
      }
    }
    await sleep(400);
  }
  return { ready: false, injected, snapshot };
}

/**
 * open_chart: navigate an existing Yahoo tab (or open a new one) to the
 * Advanced Chart page for `symbol` and wait until it's truly ready to use —
 * root-causing the "open the chart, then manually refresh once before the
 * extension connects" friction. Owns its own tab, so it bypasses the normal
 * findTargetTab routing.
 */
async function handleOpenChart(request: ToolRequest): Promise<ToolResponse> {
  const symRaw = (request.params as { symbol?: unknown }).symbol;
  const symbol = typeof symRaw === "string" ? symRaw.trim().toUpperCase() : "";
  if (!symbol) {
    return makeError(request.id, "BAD_REQUEST", "open_chart requires a non-empty symbol");
  }
  const timeoutRaw = (request.params as { timeout_ms?: unknown }).timeout_ms;
  const timeoutMs = typeof timeoutRaw === "number" && timeoutRaw > 0 ? timeoutRaw : 15000;
  const targetUrl = `https://finance.yahoo.com/chart/${encodeURIComponent(symbol)}`;

  // Reuse only an existing Yahoo CHART tab. We deliberately do NOT repurpose an
  // arbitrary finance.yahoo.com tab (a news article, portfolio, etc.) — silently
  // navigating the user away from what they were reading is worse than opening a
  // fresh tab. So: reuse a chart tab if one exists, otherwise open a new tab.
  const existing = await chrome.tabs.query({ url: "https://finance.yahoo.com/*" });
  const reuseTab = existing.find((t) => t.url && YAHOO_CHART_URL_PATTERN.test(t.url)) ?? null;

  let tabId: number | undefined;
  let reused: boolean;
  try {
    if (reuseTab?.id != null) {
      reused = true;
      await chrome.tabs.update(reuseTab.id, { url: targetUrl, active: true });
      tabId = reuseTab.id;
    } else {
      reused = false;
      const created = await chrome.tabs.create({ url: targetUrl, active: true });
      tabId = created.id;
    }
  } catch (err) {
    return makeError(request.id, "INTERNAL", `failed to open/navigate the chart tab: ${errMsg(err)}`, symbol);
  }
  if (tabId == null) {
    return makeError(request.id, "INTERNAL", "no tab id available after open/navigate", symbol);
  }

  const { ready, injected, snapshot } = await waitForTabChartReady(tabId, symbol, timeoutMs);
  if (!ready) {
    return makeError(
      request.id,
      "TIMEOUT",
      `chart for ${symbol} not ready within ${timeoutMs}ms — snapshot: ` +
        JSON.stringify({ ...snapshot, injected }),
      symbol,
      "The page may still be loading, blocked by a consent wall, or Yahoo changed the chart mount point.",
    );
  }
  const data: OpenChartResult = {
    symbol,
    url: targetUrl,
    reused_tab: reused,
    ready: true,
    engine_present: snapshot.engine_present,
    data_set_len: snapshot.data_set_len,
    injected,
  };
  return { id: request.id, ok: true, symbol, data };
}

async function routeToolRequest(request: ToolRequest): Promise<ToolResponse> {
  // open_chart owns its own tab lifecycle (create/navigate/inject/wait) and so
  // is handled before the "find an existing chart tab" routing below.
  if (request.tool === "open_chart") {
    return handleOpenChart(request);
  }

  const tab = await findTargetTab();
  if (!tab?.id) {
    return makeError(
      request.id,
      "NOT_CHART_PAGE",
      "no active Yahoo Finance chart tab found",
      null,
      "Open a Yahoo chart page, or call open_chart(symbol) to navigate there automatically.",
    );
  }

  try {
    const response = (await chrome.tabs.sendMessage(tab.id, request)) as ToolResponse | undefined;
    if (!response) {
      return makeError(request.id, "INTERNAL", "content script returned no response");
    }
    return response;
  } catch (err) {
    // findTargetTab already confirmed this tab's URL matches a Yahoo chart
    // page, so a sendMessage failure here isn't "not a chart page" — most
    // commonly it means the content script hasn't finished loading yet
    // (page still loading) or was just torn down by a navigation. That's a
    // transient, retry-worthy state, not NOT_YAHOO_CHART.
    return makeError(
      request.id,
      "NOT_READY",
      "Yahoo chart tab found but its content script isn't ready yet (page still loading) — retry shortly: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// --- Popup status/control channel -------------------------------------------
// The popup has no visibility into module-level state (socket, reconnectAttempt,
// everConnected) or the tab-finding logic above, so it asks background.ts for a
// point-in-time snapshot via chrome.runtime.sendMessage rather than duplicating
// any of that logic.

function getWsState(): "never" | "connecting" | "connected" {
  if (socket?.readyState === WebSocket.OPEN) return "connected";
  // "never" must mean "hasn't connected yet this worker session" so the popup
  // can auto-expand its first-run config help. We key this off everConnected,
  // NOT `socket === null && reconnectAttempt === 0`: the worker dials the
  // server synchronously at startup, so `socket` is essentially never null by
  // the time the popup asks — that older check was effectively dead and left
  // an unconfigured user stuck on a perpetual amber "connecting…". Once we've
  // been OPEN at least once, a non-OPEN socket means "dropped, reconnecting".
  if (everConnected) return "connecting";
  return "never";
}

/** Builds the popup's chart-status snapshot: target tab, symbol, probe result, tab count. */
async function computeChartStatus(): Promise<ChartStatus> {
  const [tab, allYahooTabs] = await Promise.all([
    findTargetTab(),
    chrome.tabs.query({ url: "https://finance.yahoo.com/*" }),
  ]);
  const tabCount = allYahooTabs.filter((t) => t.url && YAHOO_CHART_URL_PATTERN.test(t.url)).length;

  if (!tab?.id) {
    return { state: "no_tab", tabId: null, windowId: null, symbol: null, title: null, dataSetLen: 0, tabCount };
  }

  const symbol = tab.url ? extractSymbolFromUrl(tab.url) : null;
  const probe = await sendProbe(tab.id);
  let state: "loading" | "ready" = "loading";
  let dataSetLen = 0;
  if (probe?.ok && probe.data) {
    const d = probe.data as ProbeReadyResult;
    dataSetLen = d.data_set_len;
    if (d.engine_present && d.data_set_len > 0) state = "ready";
  }

  return {
    state,
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    symbol,
    title: tab.title ?? null,
    dataSetLen,
    tabCount,
  };
}

async function handleGetStatus(): Promise<GetStatusResult> {
  const chart = await computeChartStatus();
  return { ws: getWsState(), chart };
}

function handleFocusTab(message: Extract<PopupToBackgroundMessage, { type: "focusTab" }>): void {
  if (typeof message.tabId === "number") {
    chrome.tabs.update(message.tabId, { active: true }).catch(() => {});
  }
  if (typeof message.windowId === "number") {
    chrome.windows.update(message.windowId, { focused: true }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || !("type" in message)) return false;
  const msg = message as PopupToBackgroundMessage;

  if (msg.type === "getStatus") {
    handleGetStatus().then(sendResponse);
    return true; // keep the message channel open for the async sendResponse above
  }

  if (msg.type === "focusTab") {
    handleFocusTab(msg);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// --- Connection lifecycle wiring -------------------------------------------
// Listeners are registered synchronously at top level so they can wake the
// worker from suspension (MV3 requirement).

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ensureConnected();
});

// Reconnect eagerly on the events that (re)start the worker.
chrome.runtime.onStartup.addListener(() => ensureConnected());
chrome.runtime.onInstalled.addListener(() => ensureConnected());

// (Re)create the recurring wake-up alarm and open the socket right now.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_ALARM_PERIOD_MIN });
ensureConnected();
