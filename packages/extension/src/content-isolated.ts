/**
 * ISOLATED-world content script. Two jobs:
 *
 *  1. Relay: forward tool requests from background to the MAIN-world script and
 *     relay responses back (it never touches the ChartIQ engine itself).
 *  2. Persistence coordinator (issue 007): the MAIN world can't reach
 *     chrome.storage, so THIS world owns the per-symbol registry of drawings we
 *     drew. It intercepts the drawing/removal/list tools, drives the live work
 *     in MAIN via postMessage, registers what we draw, redefines clear
 *     semantics (mine vs all), and — after a refresh — replays the saved
 *     drawings once the chart is ready (recomputing anchors from the current
 *     dataSet, since we store semantic params, not stale d0/d1).
 */
import {
  BRIDGE_NS,
  makeError,
  type BridgeMessage,
  type ToolRequest,
  type ToolResponse,
} from "@tratto/shared";
import type {
  SavedDrawing,
  DrawingMatch,
  DrawResult,
  RemovalResult,
  ClearDrawingsParams,
  ClearDrawingsResult,
  RemoveDrawingParams,
  ListSavedDrawingsParams,
  ListSavedDrawingsResult,
  DeleteSavedDrawingParams,
  DeleteSavedDrawingResult,
} from "@tratto/shared";

// Generous relative to the bridge's own 8s server-side timeout — a last-resort
// safety net in case the MAIN-world script never responds at all.
const RESPONSE_TIMEOUT_MS = 10000;
// Longer budget for our own MAIN round-trips (redraw-on-load runs outside any
// server request, so nothing else bounds it).
const CALL_MAIN_TIMEOUT_MS = 15000;

const STORE_PREFIX = "ynf:draw:";

/** Drawing tools we register for persistence (their request is replayed on reload). */
const DRAW_TOOLS = new Set([
  "draw_support",
  "draw_trendline",
  "draw_fib",
  "draw_ray",
  "draw_rectangle",
  "draw_channel",
  "draw_vertical",
  "draw_callout",
  "draw_raw",
]);

/** Tools this world handles itself (drawing + removal + saved-store management). */
const COORDINATED_TOOLS = new Set<string>([
  ...DRAW_TOOLS,
  "clear_drawings",
  "remove_drawing",
  "undo_drawing",
  "list_saved_drawings",
  "delete_saved_drawing",
]);

function isToolRequest(value: unknown): value is ToolRequest {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ToolRequest).id === "string" &&
    typeof (value as ToolRequest).tool === "string" &&
    typeof (value as ToolRequest).params === "object"
  );
}

function symbolFromLocation(): string | null {
  const path = window.location.pathname;
  const match = /\/quote\/([^/]+)/.exec(path) ?? /\/chart\/([^/]+)/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]).toUpperCase() : null;
}

// --- chrome.storage helpers (per-symbol registry) --------------------------

function storeKey(symbol: string): string {
  return STORE_PREFIX + symbol.toUpperCase();
}

async function getSaved(symbol: string | null): Promise<SavedDrawing[]> {
  if (!symbol) return [];
  try {
    const key = storeKey(symbol);
    const got = await chrome.storage.local.get(key);
    const arr = got[key];
    return Array.isArray(arr) ? (arr as SavedDrawing[]) : [];
  } catch {
    return [];
  }
}

async function setSaved(symbol: string, arr: SavedDrawing[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [storeKey(symbol)]: arr });
  } catch {
    /* storage best-effort; a failed write just means this drawing won't replay */
  }
}

// chrome.storage has no transactions, and several async handlers (plus the
// fire-and-forget redraw-on-load pass) do read-modify-write on the same
// per-symbol registry. They all run in THIS single content-script context, so
// a promise-chain mutex fully serializes them — without it, an interleaved
// getSaved→…→setSaved silently clobbers a concurrent write.
let storeChain: Promise<unknown> = Promise.resolve();
function withStore<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeChain.then(fn, fn);
  storeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Atomically append one record to a symbol's registry. */
function addSaved(symbol: string, record: SavedDrawing): Promise<void> {
  return withStore(async () => {
    const arr = await getSaved(symbol);
    arr.push(record);
    await setSaved(symbol, arr);
  });
}

/** Atomically empty a symbol's registry. */
function clearSavedStore(symbol: string): Promise<void> {
  return withStore(() => setSaved(symbol, []));
}

/** Does a live exported drawing's raw fields satisfy every defined field of a match? */
function rawMatches(raw: Record<string, unknown>, m: DrawingMatch): boolean {
  if (raw["name"] !== m.name) return false;
  const near = (a: unknown, b: number) =>
    typeof a === "number" && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
  if (m.v0 !== undefined && !near(raw["v0"], m.v0)) return false;
  if (m.v1 !== undefined && !near(raw["v1"], m.v1)) return false;
  if (m.d0 !== undefined && raw["d0"] !== m.d0) return false;
  if (m.d1 !== undefined && raw["d1"] !== m.d1) return false;
  if (m.text !== undefined) {
    const rv = raw["text"];
    let t: string | null = null;
    if (typeof rv === "string") {
      try {
        t = decodeURIComponent(rv);
      } catch {
        t = rv;
      }
    }
    if (t !== m.text) return false;
  }
  return true;
}

// --- MAIN-world round-trip -------------------------------------------------

let callSeq = 0;

/** Send a request to the MAIN-world script and await its matching response. */
function callMain(tool: string, params: Record<string, unknown>): Promise<ToolResponse> {
  const id = `iso-${Date.now()}-${callSeq++}`;
  const request: ToolRequest = { id, tool, params };
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as BridgeMessage | undefined;
      if (!data || data.ns !== BRIDGE_NS || data.dir !== "res") return;
      if (data.payload.id !== id) return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(data.payload);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(makeError(id, "TIMEOUT", "no response from MAIN-world content script"));
    }, CALL_MAIN_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    window.postMessage({ ns: BRIDGE_NS, dir: "req", payload: request } satisfies BridgeMessage, "*");
  });
}

// --- Coordinated tool handling ---------------------------------------------

/** Draw a family tool via MAIN, then register it (semantic params) for replay. */
async function handleDraw(request: ToolRequest): Promise<ToolResponse> {
  const res = await callMain(request.tool, request.params);
  // NOTE: res.id is callMain's INTERNAL id, not the caller's — the bridge
  // correlates responses by id, so we MUST rebuild the envelope with
  // request.id or it never matches and times out. (This is why draw_* silently
  // hung while clear/remove/undo — which already rebuild — worked.)
  if (!res.ok) {
    return { ...res, id: request.id };
  }
  const data = res.data as DrawResult | undefined;
  const symbol = res.symbol ?? symbolFromLocation();
  if (data?.fingerprint && symbol) {
    const record: SavedDrawing = {
      id: `d-${Date.now()}-${callSeq++}`,
      tool: request.tool,
      ciq_name: data.fingerprint.name,
      params: request.params, // semantic params — replayed verbatim on reload
      match: data.fingerprint,
      created_at: Date.now(),
    };
    await addSaved(symbol, record);
    data.saved_id = record.id;
  }
  return { id: request.id, ok: true, symbol: res.symbol, data };
}

/** clear_drawings: "mine" (default) removes only our drawings; "all" removes everything. */
async function handleClear(request: ToolRequest): Promise<ToolResponse> {
  const scope = (request.params as ClearDrawingsParams).scope === "all" ? "all" : "mine";
  const symbol = symbolFromLocation();
  const saved = await withStore(() => getSaved(symbol));

  if (scope === "all") {
    // Count how many of OUR registered drawings are actually live right now, so
    // hand_drawn = removed − ourLive is accurate even when some saved entries
    // were already gone (deleted by hand, or not yet replayed after a refresh).
    const live = await callMain("read_drawings", {});
    const liveDrawings = live.ok
      ? ((live.data as { drawings?: Array<{ raw?: Record<string, unknown> }> }).drawings ?? [])
      : [];
    const ourLive = saved.filter((s) => liveDrawings.some((d) => rawMatches(d.raw ?? {}, s.match))).length;

    const res = await callMain("_clear_all", {});
    if (!res.ok) return { ...res, id: request.id };
    const rr = res.data as RemovalResult;
    if (symbol) await clearSavedStore(symbol); // our registry is gone too
    const result: ClearDrawingsResult = {
      symbol: res.symbol,
      cleared: rr.removed,
      scope: "all",
      hand_drawn: Math.max(0, rr.removed - ourLive),
    };
    if (rr.warnings?.length) result.warnings = rr.warnings;
    return { id: request.id, ok: true, symbol: res.symbol, data: result };
  }

  // scope "mine": remove exactly the drawings we registered (targeted).
  if (saved.length === 0) {
    const result: ClearDrawingsResult = { symbol, cleared: 0, scope: "mine" };
    return { id: request.id, ok: true, symbol, data: result };
  }
  const matches = saved.map((s) => s.match);
  const res = await callMain("_remove_matches", { matches });
  if (!res.ok) return { ...res, id: request.id };
  const rr = res.data as RemovalResult;
  if (symbol) await clearSavedStore(symbol); // registry cleared regardless of live outcome
  const result: ClearDrawingsResult = { symbol: res.symbol, cleared: rr.removed, scope: "mine" };
  if (rr.warnings?.length) result.warnings = rr.warnings;
  return { id: request.id, ok: true, symbol: res.symbol, data: result };
}

/** remove_drawing: targeted removal by (type, price[, price2][, text]); prunes the registry. */
async function handleRemove(request: ToolRequest): Promise<ToolResponse> {
  const p = request.params as unknown as RemoveDrawingParams;
  if (typeof p.type !== "string" || !p.type) {
    return makeError(request.id, "BAD_REQUEST", "remove_drawing requires a ChartIQ type name");
  }
  const match: DrawingMatch = { name: p.type };
  if (typeof p.price === "number") match.v0 = p.price;
  if (typeof p.price2 === "number") match.v1 = p.price2;
  if (typeof p.text === "string") match.text = p.text;

  const res = await callMain("_remove_matches", { matches: [match] });
  if (!res.ok) return { ...res, id: request.id };
  const symbol = res.symbol ?? symbolFromLocation();
  if (symbol) {
    await withStore(async () => {
      const saved = await getSaved(symbol);
      const kept = saved.filter((s) => !matchesEqualish(s.match, match));
      if (kept.length !== saved.length) await setSaved(symbol, kept);
    });
  }
  return { id: request.id, ok: true, symbol, data: res.data };
}

/** undo_drawing: undo the most recent drawing, then prune any registry entry that's gone. */
async function handleUndo(request: ToolRequest): Promise<ToolResponse> {
  const res = await callMain("_undo", {});
  if (!res.ok) return { ...res, id: request.id };
  const symbol = res.symbol ?? symbolFromLocation();
  await reconcileRegistry(symbol);
  return { id: request.id, ok: true, symbol, data: res.data };
}

async function handleListSaved(request: ToolRequest): Promise<ToolResponse> {
  const p = request.params as ListSavedDrawingsParams;
  const symbol = (typeof p.symbol === "string" && p.symbol ? p.symbol : symbolFromLocation())?.toUpperCase() ?? null;
  const saved = await getSaved(symbol);
  const result: ListSavedDrawingsResult = { symbol, count: saved.length, saved };
  return { id: request.id, ok: true, symbol, data: result };
}

async function handleDeleteSaved(request: ToolRequest): Promise<ToolResponse> {
  const p = request.params as unknown as DeleteSavedDrawingParams;
  if (typeof p.id !== "string" || !p.id) {
    return makeError(request.id, "BAD_REQUEST", "delete_saved_drawing requires an id");
  }
  // The id may belong to any symbol's list — scan all registry keys, under the
  // store lock so a concurrent draw/clear can't clobber the write.
  const { deleted, remaining, hitSymbol } = await withStore(async () => {
    let deleted = false;
    let remaining = 0;
    let hitSymbol: string | null = null;
    try {
      const all = await chrome.storage.local.get(null);
      for (const [key, val] of Object.entries(all)) {
        if (!key.startsWith(STORE_PREFIX) || !Array.isArray(val)) continue;
        const arr = val as SavedDrawing[];
        const kept = arr.filter((s) => s.id !== p.id);
        if (kept.length !== arr.length) {
          deleted = true;
          remaining = kept.length;
          hitSymbol = key.slice(STORE_PREFIX.length);
          await chrome.storage.local.set({ [key]: kept });
          break;
        }
      }
    } catch {
      /* fall through with deleted=false */
    }
    return { deleted, remaining, hitSymbol };
  });
  const result: DeleteSavedDrawingResult = { symbol: hitSymbol, deleted, remaining };
  return { id: request.id, ok: true, symbol: hitSymbol, data: result };
}

function matchesEqualish(a: DrawingMatch, b: DrawingMatch): boolean {
  if (a.name !== b.name) return false;
  const near = (x?: number, y?: number) =>
    x === undefined || y === undefined ? x === y : Math.abs(x - y) <= Math.max(1e-6, Math.abs(y) * 1e-6);
  return near(a.v0, b.v0) && near(a.v1, b.v1) && a.text === b.text;
}

/** Drop registry entries whose fingerprint is no longer live (used after undo). */
async function reconcileRegistry(symbol: string | null): Promise<void> {
  if (!symbol) return;
  // Read live drawings OUTSIDE the store lock (callMain is a slow round-trip);
  // only the read-modify-write of the registry is serialized.
  const live = await callMain("read_drawings", {});
  if (!live.ok) return;
  const drawings = (live.data as { drawings?: Array<{ raw?: Record<string, unknown> }> }).drawings ?? [];
  await withStore(async () => {
    const saved = await getSaved(symbol);
    if (!saved.length) return;
    // Compare on ALL fingerprint fields so two saved drawings that share a
    // price/anchor but differ in the far endpoint or text aren't conflated
    // (which would leave an undone one to ghost-replay on reload).
    const kept = saved.filter((s) => drawings.some((d) => rawMatches(d.raw ?? {}, s.match)));
    if (kept.length !== saved.length) await setSaved(symbol, kept);
  });
}

async function handleCoordinated(request: ToolRequest): Promise<ToolResponse> {
  try {
    if (DRAW_TOOLS.has(request.tool)) return await handleDraw(request);
    switch (request.tool) {
      case "clear_drawings":
        return await handleClear(request);
      case "remove_drawing":
        return await handleRemove(request);
      case "undo_drawing":
        return await handleUndo(request);
      case "list_saved_drawings":
        return await handleListSaved(request);
      case "delete_saved_drawing":
        return await handleDeleteSaved(request);
      default:
        return makeError(request.id, "INTERNAL", `coordinated tool not implemented: ${request.tool}`);
    }
  } catch (err) {
    return makeError(request.id, "INTERNAL", err instanceof Error ? err.message : String(err));
  }
}

// --- Redraw-on-load: replay saved drawings once the chart is ready ---------

async function waitReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await callMain("probe_ready", {});
    if (res.ok) {
      const d = res.data as { engine_present?: boolean; data_set_len?: number };
      if (d.engine_present && (d.data_set_len ?? 0) > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function redrawSaved(): Promise<void> {
  const symbol = symbolFromLocation();
  if (!symbol) return;
  const snapshot = await withStore(() => getSaved(symbol));
  if (!snapshot.length) return;
  if (!(await waitReady(15000))) return;

  // Replay outside the store lock; collect the freshly-recomputed fingerprints
  // keyed by record id.
  const fpUpdates = new Map<string, DrawResult["fingerprint"]>();
  for (const rec of snapshot) {
    const res = await callMain(rec.tool, rec.params);
    if (res.ok) {
      const fp = (res.data as DrawResult | undefined)?.fingerprint;
      if (fp) fpUpdates.set(rec.id, fp);
    }
  }
  // Merge the refreshed fingerprints into the CURRENT registry (not our stale
  // snapshot) so a clear/draw that ran during replay isn't resurrected/lost —
  // we only touch records still present, updating their match to live anchors.
  await withStore(async () => {
    const cur = await getSaved(symbol);
    let changed = false;
    for (const rec of cur) {
      const fp = fpUpdates.get(rec.id);
      if (fp) {
        rec.match = fp;
        changed = true;
      }
    }
    if (changed) await setSaved(symbol, cur);
  });
}

// --- Install (guarded) -----------------------------------------------------

// Install guard: open_chart may programmatically (re)inject this script. A
// double runtime.onMessage listener would answer each request twice (and can
// close the response channel early), so we install exactly once per page.
const guardKey = "__YNF_ISOLATED_INSTALLED__";
const w = window as unknown as Record<string, boolean | undefined>;
if (w[guardKey]) {
  // already installed — do nothing
} else {
  w[guardKey] = true;
  install();
  // Fire-and-forget: replay this symbol's saved drawings after the chart loads.
  void redrawSaved();
}

function install(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isToolRequest(message)) return false; // not ours; let other listeners handle it
    const request = message;

    // Persistence-coordinated tools are handled entirely here (they call MAIN
    // themselves for the live work); everything else is a transparent relay.
    if (COORDINATED_TOOLS.has(request.tool)) {
      handleCoordinated(request).then(sendResponse);
      return true;
    }

    const onWindowMessage = (event: MessageEvent) => {
      // Untrusted-input validation: MAIN world is shared with the host page.
      if (event.source !== window) return;
      const data = event.data as BridgeMessage | undefined;
      if (!data || data.ns !== BRIDGE_NS || data.dir !== "res") return;
      if (data.payload.id !== request.id) return; // not our response

      window.removeEventListener("message", onWindowMessage);
      clearTimeout(timer);
      sendResponse(data.payload);
    };

    const timer = setTimeout(() => {
      window.removeEventListener("message", onWindowMessage);
      const timeoutResponse: ToolResponse = makeError(
        request.id,
        "TIMEOUT",
        "no response from MAIN-world content script",
      );
      sendResponse(timeoutResponse);
    }, RESPONSE_TIMEOUT_MS);

    window.addEventListener("message", onWindowMessage);
    window.postMessage({ ns: BRIDGE_NS, dir: "req", payload: request } satisfies BridgeMessage, "*");

    return true; // keep the sendResponse channel open for the async response
  });
}
