/**
 * Shared protocol types between mcp-server and the Chrome extension.
 *
 * This file is the single source of truth for the wire format that crosses
 * THREE hops: WebSocket (server <-> background), chrome.runtime messaging
 * (background <-> isolated content script), and window.postMessage
 * (isolated <-> MAIN world content script). Keep it dependency-free so it
 * can be bundled into both a Node process and a browser extension.
 */

/**
 * Namespace tag used to mark postMessage traffic between the isolated-world
 * and MAIN-world content scripts. MAIN world is shared with Yahoo's own
 * scripts and any ad/tracking scripts on the page, so every message must be
 * tagged and validated — untagged messages are ignored, not trusted.
 */
export const BRIDGE_NS = "__YNF_BRIDGE__";

/**
 * Shared handshake constant for the WebSocket connection between the extension
 * and the local mcp-server. Browser WebSocket clients cannot set custom HTTP
 * headers, so this travels in the first application-level message ("hello")
 * rather than an Origin/Authorization header.
 *
 * NOTE: this is NOT a secret. It ships inside both the (public) extension and
 * the server, so anyone can read it — it only proves the connecting process
 * *speaks our protocol*, not that it's trustworthy. The real access control is
 * that the server binds 127.0.0.1 only and rejects any Origin that isn't a
 * chrome-extension:// one. Safe to publish.
 *
 * TODO: make configurable (env var / generated-per-install) if this ever needs
 * to defend against other local processes on the same machine.
 */
export const SHARED_TOKEN = "tratto-dev-local-token";

/** Port the mcp-server's WebSocket server binds to on 127.0.0.1. */
export const WS_PORT = 8787;

// ---------------------------------------------------------------------------
// Tool request/response envelope (crosses all three hops unchanged)
// ---------------------------------------------------------------------------

export interface ToolRequest {
  id: string;
  tool: string;
  params: Record<string, unknown>;
}

export type ToolResponse =
  | { id: string; ok: true; symbol: string | null; data: unknown }
  | {
      id: string;
      ok: false;
      symbol: string | null;
      error_code: ErrorCode;
      message: string;
      /** Optional actionable hint for the calling agent (e.g. "call open_chart"). */
      hint?: string;
    };

/**
 * Canonical structured error taxonomy, shared by both ends. Split into three
 * layers by where the failure is detected:
 *
 *  - Transport / routing (bridge + background, before we ever reach a page):
 *    NO_TAB, NOT_READY.
 *  - Page / engine (content-main, once we're on a tab): NOT_CHART_PAGE,
 *    ENGINE_NOT_FOUND, ENGINE_IN_IFRAME, DATA_NOT_READY.
 *  - Generic: TIMEOUT, BAD_REQUEST, UNSUPPORTED, ALREADY_EXISTS,
 *    UNSUPPORTED_CIQ_HANDLE, INTERNAL.
 *
 * "Report clearly, don't auto-adapt" (see CLAUDE.md known risks): a Yahoo
 * redesign that moves/breaks the engine surfaces as one of these codes plus a
 * hint, never a bare exception or a silent wrong answer.
 */
export type ErrorCode =
  // --- transport / routing (bridge + background) ---
  | "NO_TAB" // extension not connected, OR no Yahoo tab at all to target
  | "NOT_READY" // tab exists but its content script/connection isn't ready yet — retry shortly
  // --- page / engine (content-main) ---
  | "NOT_CHART_PAGE" // not a Yahoo chart page (URL mismatch / no .chartContainer)
  | "ENGINE_NOT_FOUND" // .chartContainer present but no live .stx engine
  | "ENGINE_IN_IFRAME" // engine appears sealed inside an iframe/shadowRoot we can't reach
  | "DATA_NOT_READY" // engine present but its dataSet is empty / not loaded yet
  // --- generic ---
  | "TIMEOUT" // no response / readiness within budget
  | "BAD_REQUEST" // malformed params
  | "UNSUPPORTED" // engine lacks the method/feature this tool needs (best-effort action)
  | "ALREADY_EXISTS" // the requested thing is already present (e.g. comparison series)
  | "UNSUPPORTED_CIQ_HANDLE" // could not obtain a live CIQ module handle at runtime (009)
  | "INTERNAL";

/** Convenience constructor for the `ok: false` half of a ToolResponse. */
export function makeError(
  id: string,
  error_code: ErrorCode,
  message: string,
  symbol: string | null = null,
  hint?: string,
): Extract<ToolResponse, { ok: false }> {
  const err: Extract<ToolResponse, { ok: false }> = { id, ok: false, symbol, error_code, message };
  if (hint !== undefined) err.hint = hint;
  return err;
}

// ---------------------------------------------------------------------------
// get_chart_data tool
// ---------------------------------------------------------------------------

export interface GetChartDataParams {
  /** Return only the most recent N bars of the (optionally windowed) set. */
  last_n?: number;
  /** ISO-ish inclusive lower bound on bar date. */
  from?: string;
  /** ISO-ish inclusive upper bound on bar date. */
  to?: string;
  /**
   * Downsample the selected bars to at most this many points via BUCKET
   * AGGREGATION (never stride sampling): each bucket keeps first-open,
   * max-high, min-low, last-close, sum-volume, so support/resistance extremes
   * survive.
   */
  max_points?: number;
}

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A price paired with the bar date it occurred on. */
export interface PricePoint {
  price: number;
  date: string;
}

/**
 * Compact, always-cheap summary head describing the chart and the returned
 * window. Shared by get_chart_summary (this alone) and get_chart_data (this +
 * the CSV bar block).
 */
export interface ChartSummary {
  symbol: string | null;
  /** stx.layout.interval / periodicity if available, stringified. */
  interval: string | null;
  /** Total bars currently loaded in the engine's dataSet. */
  total_bars_loaded: number;
  /** Full loaded date range (all bars in the engine). */
  loaded_range: { start: string | null; end: string | null };
  /** Most recent close in the loaded set. */
  last_close: number | null;
  /** Date range of the returned/selected window (may be narrower than loaded). */
  window_range: { start: string | null; end: string | null };
  /** Highest high over the selected window (exact, computed pre-downsample). */
  window_high: PricePoint | null;
  /** Lowest low over the selected window (exact, computed pre-downsample). */
  window_low: PricePoint | null;
  /** % change over the window: (last close − first open) / first open × 100. */
  change_pct: number | null;
  /** Non-fatal field-drift notes (empty/absent when the engine looks normal). */
  warnings?: string[];
}

export interface GetChartDataResult extends ChartSummary {
  /** Number of rows in bars_csv (after any windowing/bucketing). */
  returned_bars: number;
  /** True when fewer bars are returned than are loaded in the engine. */
  downsampled: boolean;
  /** True when max_points bucket aggregation was applied. */
  bucketed: boolean;
  /** CSV block: a "date,o,h,l,c,v" header line followed by one row per bar. */
  bars_csv: string;
}

export type GetChartSummaryResult = ChartSummary;

// ---------------------------------------------------------------------------
// open_chart tool (navigate + wait for the chart to be truly ready)
// ---------------------------------------------------------------------------

export interface OpenChartParams {
  symbol: string;
  /** Ready-wait budget in ms. Defaults to 15000. */
  timeout_ms?: number;
}

export interface OpenChartResult {
  symbol: string;
  url: string;
  /** True if an existing Yahoo tab was navigated; false if a new tab was opened. */
  reused_tab: boolean;
  ready: boolean;
  engine_present: boolean;
  data_set_len: number;
  /** True if we had to programmatically (re)inject the content scripts. */
  injected: boolean;
}

// ---------------------------------------------------------------------------
// get_capabilities tool (typeof-map of the engine methods we depend on)
// ---------------------------------------------------------------------------

/**
 * The engine methods get_capabilities probes. There is no readable CIQ.version
 * at runtime (ChartIQ ships as a closure-private ES module), so capability is
 * decided purely by "is this method present", never by guessing a version.
 */
export const CAPABILITY_METHODS = [
  "createDrawing",
  "removeDrawing",
  "undoLast",
  "clearDrawings",
  "exportDrawings",
  "importDrawings",
  "setChartType",
  "setAggregationType",
  "setPeriodicity",
  "setSpan",
  "setRange",
  "addSeries",
  "removeSeries",
  "addEventListener",
  "append",
  "prepend",
  "exportLayout",
  "importLayout",
] as const;

export type CapabilityMethod = (typeof CAPABILITY_METHODS)[number];

export interface GetCapabilitiesResult {
  symbol: string | null;
  engine_present: boolean;
  /** method name -> "function" if callable on the live engine, else "missing". */
  methods: Record<string, "function" | "missing">;
  warnings?: string[];
}

/** Internal readiness snapshot returned by the content-main `probe_ready` tool. */
export interface ProbeReadyResult {
  url: string;
  engine_present: boolean;
  data_set_len: number;
  in_iframe: boolean;
  symbol: string | null;
}

// ---------------------------------------------------------------------------
// Drawing tools (draw_support / read_drawings / clear_drawings)
// ---------------------------------------------------------------------------

export interface DrawSupportParams {
  /** Price (y-axis value) the horizontal line sits at. Required. */
  price: number;
  /** Line color as a CSS hex/name string, e.g. "#FF3B30". Optional. */
  color?: string;
  /** Line width in pixels. Optional; defaults to 1. */
  line_width?: number;
}

/**
 * AI-friendly view of one drawing, mapped out of ChartIQ's terse serialized
 * shape (name/col/lw/ptrn/v0/d0/...). `raw` preserves the exact ChartIQ
 * object so nothing is lost for round-tripping/debugging.
 */
export interface FriendlyDrawing {
  /** ChartIQ tool name, e.g. "horizontal", "segment", "fibonacci". */
  type: string;
  /** Primary price for single-value tools (horizontal); null otherwise. */
  price: number | null;
  color: string | null;
  line_width: number | null;
  pattern: string | null;
  /** Raw serialized ChartIQ drawing (exportDrawings() element). */
  raw: Record<string, unknown>;
}

export interface DrawSupportResult {
  symbol: string | null;
  /** The drawing that was just created, in friendly form. */
  drawn: FriendlyDrawing;
  /** Total number of drawings on the chart after this one was added. */
  total_drawings: number;
  /** Value fingerprint for later remove_drawing / persistence registration. */
  fingerprint?: DrawingMatch;
  /**
   * Best-effort nudge toward Yahoo's immersive Advanced Chart page when the
   * user is currently on the embedded quote-page chart. Omitted when already
   * on the immersive page (or when it can't be determined).
   */
  view_hint?: string;
}

export interface DrawTrendlineParams {
  /** Date (ISO-ish string, e.g. as emitted by get_chart_data) for point 1. Required. */
  date1: string;
  /** Price (y-axis value) for point 1. Required. */
  price1: number;
  /** Date (ISO-ish string) for point 2. Required. */
  date2: string;
  /** Price (y-axis value) for point 2. Required. */
  price2: number;
  /** Line color as a CSS hex/name string, e.g. "#FF3B30". Optional. */
  color?: string;
  /** Line width in pixels. Optional; defaults to 1. */
  line_width?: number;
}

export interface DrawFibParams {
  /** Date (ISO-ish string) for anchor point 1 (typically a swing high or low). Required. */
  date1: string;
  /** Price (y-axis value) for anchor point 1. Required. */
  price1: number;
  /** Date (ISO-ish string) for anchor point 2. Required. */
  date2: string;
  /** Price (y-axis value) for anchor point 2. Required. */
  price2: number;
  /** Line color as a CSS hex/name string, e.g. "#FF3B30". Optional. */
  color?: string;
}

/**
 * Which loaded dataSet bar each requested date snapped to, echoed back so the
 * calling agent can see exactly where the endpoints landed (dates that don't
 * line up with a loaded bar get snapped to the nearest one).
 */
export interface SnappedEndpoints {
  date1: string | null;
  date2: string | null;
}

export interface DrawTrendlineResult {
  symbol: string | null;
  /** The drawing that was just created, in friendly form. */
  drawn: FriendlyDrawing;
  /** Total number of drawings on the chart after this one was added. */
  total_drawings: number;
  /** Value fingerprint for later remove_drawing / persistence registration. */
  fingerprint?: DrawingMatch;
  /** Which loaded bar each endpoint date snapped to. */
  snapped: SnappedEndpoints;
  /**
   * Best-effort nudge toward Yahoo's immersive Advanced Chart page when the
   * user is currently on the embedded quote-page chart. Omitted when already
   * on the immersive page (or when it can't be determined).
   */
  view_hint?: string;
}

export interface DrawFibResult {
  symbol: string | null;
  /** The drawing that was just created, in friendly form. */
  drawn: FriendlyDrawing;
  /** Total number of drawings on the chart after this one was added. */
  total_drawings: number;
  /** Value fingerprint for later remove_drawing / persistence registration. */
  fingerprint?: DrawingMatch;
  /** Which loaded bar each endpoint date snapped to. */
  snapped: SnappedEndpoints;
  /**
   * Best-effort nudge toward Yahoo's immersive Advanced Chart page when the
   * user is currently on the embedded quote-page chart. Omitted when already
   * on the immersive page (or when it can't be determined).
   */
  view_hint?: string;
}

export interface ReadDrawingsResult {
  symbol: string | null;
  count: number;
  drawings: FriendlyDrawing[];
}

// ---------------------------------------------------------------------------
// Drawing families (issue 007): ray / rectangle / channel / vertical / callout
// + draw_raw escape hatch. Recipes empirically harvested on live Yahoo.
// ---------------------------------------------------------------------------

/** Two-point drawings that share the segment recipe (ray, rectangle, channel). */
export interface DrawTwoPointParams {
  date1: string;
  price1: number;
  date2: string;
  price2: number;
  color?: string;
  line_width?: number;
  /** Fill color for area shapes (rectangle/channel). Optional; engine derives one if omitted. */
  fill_color?: string;
}

/** A vertical line at a single time anchor. */
export interface DrawVerticalParams {
  date: string;
  color?: string;
  line_width?: number;
  /** Line pattern: "solid" | "dashed" | "dotted". Optional; defaults to solid. */
  pattern?: string;
}

/** A text callout/annotation anchored at a (date, price). */
export interface DrawCalloutParams {
  date: string;
  price: number;
  text: string;
  color?: string;
  /** true → boxed callout; false → borderless annotation. Defaults to true (boxed). */
  boxed?: boolean;
}

/** Escape hatch: pass a ChartIQ tool name + already-serialized params straight through. */
export interface DrawRawParams {
  type: string;
  params: Record<string, unknown>;
}

/** Generic result for a single created drawing. */
export interface DrawResult {
  symbol: string | null;
  drawn: FriendlyDrawing;
  total_drawings: number;
  /** Compact serialized fingerprint (name + prices [+ text]) for later remove_drawing. */
  fingerprint: DrawingMatch;
  /** id under which this drawing was registered for persistence (present when persisted). */
  saved_id?: string;
  /** Which loaded bar each supplied date snapped to (two-point/anchored tools). */
  snapped?: SnappedEndpoints;
  view_hint?: string;
}

/** Match criteria for locating live drawings to remove (by value, not array index). */
export interface DrawingMatch {
  /** ChartIQ tool name, e.g. "horizontal", "segment", "callout". */
  name: string;
  v0?: number;
  v1?: number;
  /** CIQ time anchors — used to fingerprint time-only tools (e.g. vertical). */
  d0?: string;
  d1?: string;
  /** For text tools (callout/annotation); compared after URL-decoding. */
  text?: string;
}

// --- removal / undo / clear ------------------------------------------------

export interface RemoveDrawingParams {
  /** ChartIQ tool name to match (e.g. "horizontal", "segment", "callout"). */
  type: string;
  /** Primary price to match. */
  price?: number;
  /** Second price (two-point tools). */
  price2?: number;
  /** Text to match (callout/annotation). */
  text?: string;
}

/** MAIN-side batch removal request (internal; isolated world builds it). */
export interface RemoveMatchesParams {
  matches: DrawingMatch[];
}

export interface RemovalResult {
  symbol: string | null;
  /** Drawings removed (verified via exportDrawings recheck, not by whether the call threw). */
  removed: number;
  /** Drawings still on the chart after removal. */
  remaining: number;
  /** True if Yahoo's undo stack restored a target and we had to re-remove it. */
  restored?: boolean;
  warnings?: string[];
}

export interface UndoDrawingResult {
  symbol: string | null;
  removed: number;
  remaining: number;
  warnings?: string[];
}

export interface ClearDrawingsParams {
  /** "mine" (default): only drawings we drew; "all": everything incl. hand-drawn. */
  scope?: "mine" | "all";
}

export interface ClearDrawingsResult {
  symbol: string | null;
  /** How many drawings were removed. */
  cleared: number;
  scope: "mine" | "all";
  /** For scope:"all", how many of the cleared were NOT ours (hand-drawn by the user). */
  hand_drawn?: number;
  warnings?: string[];
}

// --- persistence store (chrome.storage.local, keyed by symbol) -------------

/** One AI-drawn drawing we registered so it can be replayed after a refresh. */
export interface SavedDrawing {
  id: string;
  /** The MCP tool that drew it, e.g. "draw_support" — replayed verbatim on reload. */
  tool: string;
  /** ChartIQ tool name, for fingerprint matching against live drawings. */
  ciq_name: string;
  /** Semantic params (prices/dates/text/color) — NOT d0/d1 anchors (recomputed on replay). */
  params: Record<string, unknown>;
  /** Value fingerprint for matching this drawing among live ones. */
  match: DrawingMatch;
  created_at: number;
}

export interface ListSavedDrawingsParams {
  /** Symbol to list; defaults to the current chart's symbol. */
  symbol?: string;
}

export interface ListSavedDrawingsResult {
  symbol: string | null;
  count: number;
  saved: SavedDrawing[];
}

export interface DeleteSavedDrawingParams {
  id: string;
}

export interface DeleteSavedDrawingResult {
  symbol: string | null;
  deleted: boolean;
  remaining: number;
}

// ---------------------------------------------------------------------------
// View-control tools (issue 008): chart style, periodicity, range, comparison
// series. Recipes empirically harvested on live Yahoo (see CLAUDE.md-adjacent
// issue notes) — setChartType/setAggregationType are SYNC; setPeriodicity/
// setSpan/setRange/addSeries are ASYNC (they trigger a quotefeed reload).
// ---------------------------------------------------------------------------

export interface SetChartStyleParams {
  /** e.g. "candle" | "line" | "mountain" | "bar" | "hlc" | "hollow_candle" | "baseline_delta" | "step". */
  chartType?: string;
  /** e.g. "heikinashi" | "kagi" | "renko" | "pandf" | "rangebars" | "linebreak". */
  aggregationType?: string;
}

export interface SetChartStyleResult {
  symbol: string | null;
  chartType: string | null;
  aggregationType: string | null;
  warnings?: string[];
}

export interface SetPeriodicityParams {
  /** Bar interval: a number of minutes (intraday) or "week"/"day"/etc alongside timeUnit. */
  interval: string | number;
  /** Period multiplier. Optional; defaults to 1. */
  period?: number;
  /** e.g. "minute" | "day" | "week". Optional — omit for weekly (interval:"week" carries the unit itself). */
  timeUnit?: string;
  /** Ready-wait budget for the async reload, in ms. Optional; defaults to 10000. */
  timeout_ms?: number;
}

export interface SetPeriodicityResult {
  symbol: string | null;
  interval: string | null;
  timeUnit: string | null;
  periodicity: number | null;
  total_bars: number;
  /** True when the engine's dataSet array reference actually changed (a real reload happened). */
  dataset_rebuilt: boolean;
  warnings?: string[];
}

export interface SetRangeParams {
  /** Relative span shorthand, e.g. "1y" | "6m" | "3m" | "5d" | "1d" | "ytd" | "all". */
  span?: string;
  /** Explicit range start (ISO-ish), used with `end` instead of `span`. */
  start?: string;
  /** Explicit range end (ISO-ish), used with `start` instead of `span`. */
  end?: string;
  /** Ready-wait budget for the async reload, in ms. Optional; defaults to 10000. */
  timeout_ms?: number;
}

export interface SetRangeResult {
  symbol: string | null;
  interval: string | null;
  timeUnit: string | null;
  total_bars: number;
  /** Loaded date range after the reload (from the dataSet's first/last bar). */
  range: { start: string | null; end: string | null };
  dataset_rebuilt: boolean;
  warnings?: string[];
}

export interface AddComparisonParams {
  /** Ticker symbol to overlay as a comparison series, e.g. "MSFT". */
  symbol: string;
  /** Series color as a CSS hex/name string. Optional. */
  color?: string;
  /** Ready-wait budget for the async reload, in ms. Optional; defaults to 10000. */
  timeout_ms?: number;
}

export interface AddComparisonResult {
  /** The comparison symbol that was added (chart's own symbol stays in the envelope's top-level `symbol`). */
  added: string;
  /** All comparison series currently on the chart. */
  series: string[];
  /** Adding a comparison switches the y-axis to a percentage scale. */
  percent_axis: true;
  note: string;
  warnings?: string[];
}

export interface RemoveComparisonParams {
  /** Comparison symbol to remove, e.g. "MSFT". */
  symbol: string;
}

export interface RemoveComparisonResult {
  removed: string;
  /** All comparison series remaining on the chart after removal. */
  series: string[];
  /** True if any comparison series remain (y-axis stays percentage); false once the last is removed. */
  percent_axis: boolean;
}

// ---------------------------------------------------------------------------
// Indicator tools (issue 009): official ChartIQ Studies, driven through a
// runtime-recovered CIQ module handle — window.CIQ is unreachable (ChartIQ
// ships as a closure-private ES module), so content-main scans the page's
// loaded JS modules for an export matching the live engine's constructor.
// When that handle can't be found, these tools fail with
// UNSUPPORTED_CIQ_HANDLE rather than faking results.
// ---------------------------------------------------------------------------

/** One active study, normalized (zero-width chars stripped from both fields). */
export interface ActiveStudy {
  name: string;
  type: string;
}

export interface ListIndicatorsResult {
  symbol: string | null;
  /** Normalized (zero-width-stripped) studyLibrary keys, sorted. */
  available: string[];
  available_count: number;
  active: ActiveStudy[];
}

export interface AddIndicatorParams {
  /** Library key (or a case-insensitive substring match), e.g. "rsi", "ma", "Bollinger Bands". */
  type: string;
  /** Study-specific inputs, e.g. { Period: 14 }. Optional — engine defaults are used otherwise. */
  inputs?: Record<string, unknown>;
}

export interface RemoveIndicatorParams {
  /** Active study's type or name (case-insensitive, substring match on name), e.g. "rsi". */
  type: string;
}

/** Result of add_indicator (added set) or remove_indicator (removed set). */
export interface IndicatorResult {
  symbol: string | null;
  added?: string;
  removed?: string;
  type: string;
  active: ActiveStudy[];
}

// ---------------------------------------------------------------------------
// Corporate events (issue 009): read from stx.chart.masterData rows
// (dividends/splits), plus a best-effort toggle of Yahoo's own toolbar
// control for showing them on the chart.
// ---------------------------------------------------------------------------

export interface GetCorporateEventsResult {
  symbol: string | null;
  count: number;
  /** CSV block: a "date,type,value" header line followed by one row per event. */
  events_csv: string;
  note: string;
}

export interface ToggleCorporateEventsResult {
  symbol: string | null;
  toggled: true;
  /** Text/aria-label of the toolbar control that was clicked. */
  label: string;
}

// ---------------------------------------------------------------------------
// Bridge wire messages (window.postMessage between isolated <-> MAIN world)
// ---------------------------------------------------------------------------

export interface BridgeRequestMessage {
  ns: typeof BRIDGE_NS;
  dir: "req";
  payload: ToolRequest;
}

export interface BridgeResponseMessage {
  ns: typeof BRIDGE_NS;
  dir: "res";
  payload: ToolResponse;
}

export type BridgeMessage = BridgeRequestMessage | BridgeResponseMessage;

// ---------------------------------------------------------------------------
// WebSocket control messages (server <-> extension background)
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: "hello";
  token: string;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

/** Messages the extension sends over the WS, besides ToolResponse. */
export type ExtensionWsMessage = HelloMessage | PingMessage;

/** Messages the server sends over the WS, besides ToolRequest. */
export type ServerWsMessage = PongMessage;
