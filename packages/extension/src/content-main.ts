/**
 * MAIN-world content script. This is the ONLY place that ever touches the
 * live ChartIQ engine (`document.querySelector('.chartContainer').stx`).
 * It must run in MAIN world because Yahoo's engine instance is a page-level
 * global, invisible to the ISOLATED world content scripts normally used by
 * extensions.
 *
 * MAIN world is shared with Yahoo's own scripts and any third-party
 * (ad/analytics) scripts on the page — it is NOT a trusted sandbox. Every
 * inbound postMessage is validated before use, and we deliberately hold no
 * long-lived reference to the engine: each request re-queries
 * `.chartContainer.stx` fresh (see resolveEngine), so a Yahoo re-render/remount
 * between calls can't leave us holding a stale/detached engine object.
 */
import { BRIDGE_NS, makeError, type BridgeMessage, type ToolResponse, type ErrorCode } from "@tratto/shared";
import type {
  GetChartDataParams,
  GetChartDataResult,
  GetChartSummaryResult,
  ChartSummary,
  Bar,
  PricePoint,
  DrawSupportParams,
  DrawSupportResult,
  DrawTrendlineParams,
  DrawTrendlineResult,
  DrawFibParams,
  DrawFibResult,
  FriendlyDrawing,
  ReadDrawingsResult,
  GetCapabilitiesResult,
  ProbeReadyResult,
  DrawTwoPointParams,
  DrawVerticalParams,
  DrawCalloutParams,
  DrawRawParams,
  DrawResult,
  DrawingMatch,
  RemoveMatchesParams,
  RemovalResult,
  UndoDrawingResult,
  SetChartStyleParams,
  SetChartStyleResult,
  SetPeriodicityParams,
  SetPeriodicityResult,
  SetRangeParams,
  SetRangeResult,
  AddComparisonParams,
  AddComparisonResult,
  RemoveComparisonParams,
  RemoveComparisonResult,
  ActiveStudy,
  ListIndicatorsResult,
  AddIndicatorParams,
  RemoveIndicatorParams,
  IndicatorResult,
  GetCorporateEventsResult,
  ToggleCorporateEventsResult,
} from "@tratto/shared";
import { CAPABILITY_METHODS } from "@tratto/shared";

const DEFAULT_LAST_N = 50;

// One ChartIQ drawing object as returned by createDrawing(). No official
// public types exist; we only reach for the two members we must set by hand
// (panelName + adjust) — see handleDrawSupport for why both are required.
interface ChartIqDrawing {
  panelName?: string;
  adjust?: () => void;
}

// ChartIQ has no official public TypeScript types; this is a deliberately
// loose/defensive shape covering only the fields we read/call.
interface ChartIqEngine {
  chart?: {
    symbol?: string;
    dataSet?: unknown[];
    panel?: { name?: string };
    /** Comparison series currently overlaid on the chart, keyed by symbol. */
    series?: Record<string, unknown>;
    /** Full unwindowed data (incl. divs/splits) — only populated in daily+ view (issue 009). */
    masterData?: unknown[];
  };
  layout?: {
    interval?: string | number;
    periodicity?: string | number;
    chartType?: string;
    aggregationType?: string;
    timeUnit?: string | null;
    /** Active studies, keyed by a zero-width-wrapped instance name (issue 009). */
    studies?: Record<string, unknown>;
  };
  createDrawing?: (name: string, params: Record<string, unknown>) => ChartIqDrawing;
  exportDrawings?: () => Array<Record<string, unknown>>;
  clearDrawings?: () => void;
  removeDrawing?: (drawing: unknown) => void;
  undoLast?: () => void;
  drawingObjects?: unknown[];
  draw?: () => void;
  setChartType?: (chartType: string) => void;
  setAggregationType?: (aggregationType: string) => void;
  setPeriodicity?: (
    params: { period?: number; interval: string | number; timeUnit?: string },
    cb?: (err?: unknown) => void,
  ) => void;
  setSpan?: (params: { multiplier: number; base: string }, cb?: (err?: unknown) => void) => void;
  setRange?: (params: { dtLeft: Date; dtRight: Date }, cb?: (err?: unknown) => void) => void;
  addSeries?: (
    symbol: string,
    params: { isComparison?: boolean; color?: string },
    cb?: (err?: unknown) => void,
  ) => void;
  removeSeries?: (symbol: string) => void;
  [key: string]: unknown;
}

type EngineEl = Element & { stx?: ChartIqEngine };

/**
 * Locates the ChartIQ container. Returns whether it was found directly, and —
 * when it wasn't — whether it looks like it's sealed inside an iframe/shadow
 * root we can't reach (diagnostic only; we report, we don't tunnel in).
 */
function detectContainer(): { el: EngineEl | null; inIframe: boolean } {
  const direct = document.querySelector(".chartContainer") as EngineEl | null;
  if (direct) return { el: direct, inIframe: false };

  // Best-effort: is the container living inside an iframe (possibly
  // cross-origin) or an open shadow root? This is purely to hand back a more
  // precise error code — we never try to drive an engine we can't reach.
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      const doc = (frame as HTMLIFrameElement).contentDocument;
      if (doc && doc.querySelector(".chartContainer")) return { el: null, inIframe: true };
    } catch {
      // Cross-origin frame: access throws. Treat as a possible host.
      return { el: null, inIframe: true };
    }
  }
  for (const host of Array.from(document.querySelectorAll("*"))) {
    const root = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (root && root.querySelector(".chartContainer")) return { el: null, inIframe: true };
  }
  return { el: null, inIframe: false };
}

type EngineResolution =
  | { engine: ChartIqEngine; symbol: string | null }
  | { engine: null; error_code: ErrorCode; message: string; hint?: string; symbol: string | null };

/**
 * Fresh, per-call resolution of the live engine into either an engine handle
 * or a precise structured error. Never caches: symbol/period changes make the
 * engine rebuild, so any held reference would go stale.
 */
function resolveEngine(): EngineResolution {
  const { el, inIframe } = detectContainer();
  const symbol = symbolFromLocation();
  if (el) {
    const stx = el.stx;
    if (!stx) {
      return {
        engine: null,
        error_code: "ENGINE_NOT_FOUND",
        message: ".chartContainer is present but its live .stx engine isn't attached yet",
        hint: "The chart is still initializing — retry shortly, or call open_chart to (re)load it.",
        symbol,
      };
    }
    return { engine: stx, symbol: stx.chart?.symbol ?? symbol };
  }
  if (inIframe) {
    return {
      engine: null,
      error_code: "ENGINE_IN_IFRAME",
      message: "the ChartIQ container appears to be inside an iframe/shadow root this script can't reach",
      hint: "Yahoo may have changed how the chart is embedded; the engine surface is out of reach.",
      symbol,
    };
  }
  return {
    engine: null,
    error_code: "NOT_CHART_PAGE",
    message: "no Yahoo Finance ChartIQ container (.chartContainer) found on this page",
    hint: "Open a Yahoo chart page, or call open_chart(symbol) to navigate there.",
    symbol,
  };
}

function symbolFromLocation(): string | null {
  // Two supported URL shapes: /quote/AAPL/chart (quote page) and
  // /chart/AAPL (dedicated chart page).
  const path = window.location.pathname;
  const match = /\/quote\/([^/]+)/.exec(path) ?? /\/chart\/([^/]+)/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Best-effort, side-effect-free nudge toward Yahoo's immersive Advanced
 * Chart page (a SEPARATE page at /chart/<symbol>, not a layout/fullscreen
 * flag — `stx.layout.fullScreen` is always true on both page types and does
 * NOT control this). Returns undefined when already on the immersive page
 * (nothing to say) or when the hint can't be determined; never throws.
 */
function viewHint(symbol: string | null): string | undefined {
  try {
    const path = window.location.pathname;
    if (path.startsWith("/chart/")) return undefined; // already immersive
    return (
      "You're on Yahoo's embedded quote-page chart. For a larger, immersive view " +
      "you can open the Advanced Chart at https://finance.yahoo.com/chart/" +
      (symbol ?? "<SYMBOL>") +
      " — drawing works the same either way."
    );
  } catch {
    return undefined;
  }
}

/** Best-effort ISO-ish date string extraction from a ChartIQ dataSet row. */
function extractDate(row: Record<string, unknown>): string {
  const dt = row["DT"] ?? row["Date"] ?? row["date"];
  if (dt instanceof Date) {
    const t = dt.getTime();
    return Number.isNaN(t) ? "" : dt.toISOString();
  }
  if (typeof dt === "string") return dt;
  if (typeof dt === "number") {
    const d = new Date(dt);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return "";
}

function num(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return NaN;
}

function toBar(rawRow: unknown): Bar | null {
  if (!rawRow || typeof rawRow !== "object") return null;
  const row = rawRow as Record<string, unknown>;
  const bar: Bar = {
    date: extractDate(row),
    open: num(row, "Open", "open"),
    high: num(row, "High", "high"),
    low: num(row, "Low", "low"),
    close: num(row, "Close", "close"),
  };
  const volume = num(row, "Volume", "volume");
  if (Number.isFinite(volume)) bar.volume = volume;
  if (!bar.date || [bar.open, bar.high, bar.low, bar.close].some((v) => !Number.isFinite(v))) {
    return null; // skip malformed rows rather than poisoning the response
  }
  return bar;
}

// --- get_chart_data / get_chart_summary -----------------------------------

/** Round to <=4 decimals and strip trailing zeros; empty string for non-finite. */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "";
  return String(Math.round(v * 1e4) / 1e4);
}

function fmtVol(v: number | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "";
}

/**
 * Downsample to at most `maxPoints` via CONTIGUOUS BUCKET AGGREGATION — never
 * stride sampling. Each bucket keeps first-open / max-high / min-low /
 * last-close / sum-volume, so a support/resistance extreme inside a bucket
 * survives instead of being sampled away.
 */
function bucketAggregate(bars: Bar[], maxPoints: number): Bar[] {
  const n = bars.length;
  if (maxPoints <= 0 || maxPoints >= n) return bars;
  const out: Bar[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor((i * n) / maxPoints);
    const end = Math.max(Math.floor(((i + 1) * n) / maxPoints), start + 1); // exclusive, >=1 wide
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    let hasVol = false;
    for (let j = start; j < end; j++) {
      const b = bars[j];
      if (!b) continue;
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      if (b.volume !== undefined) {
        vol += b.volume;
        hasVol = true;
      }
    }
    const firstBar = bars[start]!;
    const lastBar = bars[end - 1]!;
    const bucket: Bar = {
      date: firstBar.date,
      open: firstBar.open,
      high,
      low,
      close: lastBar.close,
    };
    if (hasVol) bucket.volume = vol;
    out.push(bucket);
  }
  return out;
}

/** Select the requested window from all loaded bars (from/to, then last_n, else default). */
function selectWindow(all: Bar[], params: GetChartDataParams): Bar[] {
  let sel = all;
  const hasFrom = typeof params.from === "string" && params.from.length > 0;
  const hasTo = typeof params.to === "string" && params.to.length > 0;
  if (hasFrom || hasTo) {
    const fromT = hasFrom ? Date.parse(params.from as string) : -Infinity;
    const toT = hasTo ? Date.parse(params.to as string) : Infinity;
    sel = sel.filter((b) => {
      const t = Date.parse(b.date);
      return !Number.isNaN(t) && t >= fromT && t <= toT;
    });
  }
  const hasLastN = typeof params.last_n === "number" && params.last_n > 0;
  const hasMaxPoints = typeof params.max_points === "number" && params.max_points > 0;
  if (hasLastN) {
    const n = Math.floor(params.last_n as number);
    sel = sel.slice(Math.max(0, sel.length - n));
  } else if (!hasFrom && !hasTo && !hasMaxPoints) {
    // Default token diet: the most recent DEFAULT_LAST_N bars only.
    sel = sel.slice(Math.max(0, sel.length - DEFAULT_LAST_N));
  }
  return sel;
}

/** Build the compact summary head over the selected (full-resolution) window. */
function buildSummary(
  stx: ChartIqEngine,
  symbol: string | null,
  all: Bar[],
  windowBars: Bar[],
  warnings: string[],
): ChartSummary {
  const interval = stx.layout?.interval ?? stx.layout?.periodicity;
  let high: PricePoint | null = null;
  let low: PricePoint | null = null;
  for (const b of windowBars) {
    if (!high || b.high > high.price) high = { price: b.high, date: b.date };
    if (!low || b.low < low.price) low = { price: b.low, date: b.date };
  }
  if (windowBars.length === 0 && all.length > 0) {
    warnings.push(
      "no bars matched the requested window (from/to/last_n) — summary fields are null; " +
        "widen the range or check the dates against loaded_range",
    );
  }
  const first = windowBars[0];
  const last = windowBars[windowBars.length - 1];
  const change_pct =
    first && last && Number.isFinite(first.open) && first.open !== 0
      ? Math.round(((last.close - first.open) / first.open) * 1e4) / 100
      : null;

  const summary: ChartSummary = {
    symbol,
    interval: interval === undefined || interval === null ? null : String(interval),
    total_bars_loaded: all.length,
    loaded_range: { start: all[0]?.date ?? null, end: all[all.length - 1]?.date ?? null },
    last_close: last ? last.close : all[all.length - 1]?.close ?? null,
    window_range: { start: first?.date ?? null, end: last?.date ?? null },
    window_high: high,
    window_low: low,
    change_pct,
  };
  if (warnings.length) summary.warnings = warnings;
  return summary;
}

/** Parse the loaded dataSet into bars, collecting field-drift warnings. */
function parseAllBars(dataSet: unknown[]): { bars: Bar[]; warnings: string[] } {
  const warnings: string[] = [];
  const bars = dataSet.map(toBar).filter((b): b is Bar => b !== null);
  if (dataSet.length > 0 && bars.length / dataSet.length < 0.9) {
    warnings.push(
      `field-drift: only ${bars.length}/${dataSet.length} dataSet rows parsed into OHLC bars — ` +
        "ChartIQ row field names may have changed",
    );
  }
  return { bars, warnings };
}

function handleGetChartData(id: string, params: GetChartDataParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }

  const { bars: allBars, warnings } = parseAllBars(dataSet);
  if (allBars.length === 0) {
    return makeError(id, "DATA_NOT_READY", "dataSet present but no bars parsed", symbol);
  }

  const windowBars = selectWindow(allBars, params);
  const summary = buildSummary(stx, symbol, allBars, windowBars, warnings);

  const hasMaxPoints = typeof params.max_points === "number" && params.max_points > 0;
  const finalBars = hasMaxPoints
    ? bucketAggregate(windowBars, Math.floor(params.max_points as number))
    : windowBars;
  const bucketed = hasMaxPoints && finalBars.length < windowBars.length;

  const rows = finalBars.map(
    (b) => `${b.date},${fmtNum(b.open)},${fmtNum(b.high)},${fmtNum(b.low)},${fmtNum(b.close)},${fmtVol(b.volume)}`,
  );
  const bars_csv = ["date,o,h,l,c,v", ...rows].join("\n");

  const result: GetChartDataResult = {
    ...summary,
    returned_bars: finalBars.length,
    downsampled: finalBars.length < allBars.length,
    bucketed,
    bars_csv,
  };
  return { id, ok: true, symbol, data: result };
}

function handleGetChartSummary(id: string): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }
  const { bars: allBars, warnings } = parseAllBars(dataSet);
  if (allBars.length === 0) {
    return makeError(id, "DATA_NOT_READY", "dataSet present but no bars parsed", symbol);
  }
  // Summary window mirrors get_chart_data's default (last DEFAULT_LAST_N) so
  // window_high/low/change describe the same recent stretch an agent sees by
  // default — but this tool ships ZERO bars.
  const windowBars = selectWindow(allBars, {});
  const result: GetChartSummaryResult = buildSummary(stx, symbol, allBars, windowBars, warnings);
  return { id, ok: true, symbol, data: result };
}

// --- get_capabilities ------------------------------------------------------

function handleGetCapabilities(id: string): ToolResponse {
  const r = resolveEngine();
  const symbol = r.symbol;
  if (!r.engine) {
    // Still answer usefully: report engine_present:false and all methods
    // "missing" rather than erroring, so the agent can diagnose.
    const methods: Record<string, "function" | "missing"> = {};
    for (const m of CAPABILITY_METHODS) methods[m] = "missing";
    const result: GetCapabilitiesResult = {
      symbol,
      engine_present: false,
      methods,
      warnings: [`${r.error_code}: ${r.message}`],
    };
    return { id, ok: true, symbol, data: result };
  }
  const stx = r.engine;
  const methods: Record<string, "function" | "missing"> = {};
  for (const m of CAPABILITY_METHODS) {
    methods[m] = typeof (stx as Record<string, unknown>)[m] === "function" ? "function" : "missing";
  }
  const result: GetCapabilitiesResult = { symbol, engine_present: true, methods };
  return { id, ok: true, symbol, data: result };
}

// --- probe_ready (internal, used by open_chart's ready-wait) ---------------

function handleProbeReady(id: string): ToolResponse {
  const { el, inIframe } = detectContainer();
  const stx = el?.stx ?? null;
  const dataSet = stx?.chart?.dataSet;
  const result: ProbeReadyResult = {
    url: window.location.href,
    engine_present: !!stx,
    data_set_len: Array.isArray(dataSet) ? dataSet.length : 0,
    in_iframe: inIframe,
    symbol: stx?.chart?.symbol ?? symbolFromLocation(),
  };
  // probe_ready never fails — it's a readiness snapshot, not an operation.
  return { id, ok: true, symbol: result.symbol, data: result };
}

/**
 * In-page readiness wait: resolves once the engine is attached and its dataSet
 * is populated, or on timeout. Shared helper for later issues (007 auto-redraw
 * on load, 008 async data reload) — the single predicate for "the chart is
 * truly ready to read/draw/act on".
 */
export function waitForChartReady(
  timeoutMs = 15000,
  pollMs = 200,
): Promise<{ ready: boolean; engine_present: boolean; data_set_len: number }> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const el = document.querySelector(".chartContainer") as EngineEl | null;
      const stx = el?.stx ?? null;
      const dataSet = stx?.chart?.dataSet;
      const len = Array.isArray(dataSet) ? dataSet.length : 0;
      if (stx && len > 0) {
        resolve({ ready: true, engine_present: true, data_set_len: len });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ ready: false, engine_present: !!stx, data_set_len: len });
        return;
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

// --- View-control tools (issue 008) -----------------------------------------

/** Outcome of an async engine call that reloads the dataSet (periodicity/span/range/comparison). */
interface ReloadOutcome {
  ok: boolean;
  timedOut: boolean;
  error: string | null;
  /** True when stx.chart.dataSet is a NEW array reference — proof a real reload happened. */
  dataset_rebuilt: boolean;
  total_bars: number;
}

/**
 * Wraps a ChartIQ async call that takes a Node-style `(err?) => void` callback
 * (setPeriodicity / setSpan / setRange / addSeries) into a Promise, guarding
 * against: the callback never firing (timeout), the callback firing more than
 * once (double-settle), and invoke() throwing synchronously before ever
 * reaching the engine's own async machinery.
 */
function awaitEngineReload(
  stx: ChartIqEngine,
  invoke: (cb: (err?: unknown) => void) => void,
  timeoutMs = 10000,
): Promise<ReloadOutcome> {
  const prevDataSet = stx.chart?.dataSet;
  const snapshot = (): { dataset_rebuilt: boolean; total_bars: number } => {
    const ds = stx.chart?.dataSet;
    return { dataset_rebuilt: ds !== prevDataSet, total_bars: Array.isArray(ds) ? ds.length : 0 };
  };

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timedOut: true, error: null, ...snapshot() });
    }, timeoutMs);

    const cb = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !err,
        timedOut: false,
        error: err ? (err instanceof Error ? err.message : String(err)) : null,
        ...snapshot(),
      });
    };

    try {
      invoke(cb);
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        timedOut: false,
        error: e instanceof Error ? e.message : String(e),
        ...snapshot(),
      });
    }
  });
}

function layoutStr(v: string | number | null | undefined): string | null {
  return v === undefined || v === null ? null : String(v);
}

function handleSetChartStyle(id: string, params: SetChartStyleParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const hasChartType = typeof params.chartType === "string" && params.chartType.length > 0;
  const hasAggregationType = typeof params.aggregationType === "string" && params.aggregationType.length > 0;
  if (hasChartType && hasAggregationType) {
    return makeError(id, "BAD_REQUEST", "pass only one of chartType or aggregationType, not both", symbol);
  }
  if (!hasChartType && !hasAggregationType) {
    return makeError(id, "BAD_REQUEST", "one of chartType or aggregationType is required", symbol);
  }

  const warnings: string[] = [];
  const beforeAggregation = stx.layout?.aggregationType;

  if (hasChartType) {
    if (typeof stx.setChartType !== "function") {
      return makeError(id, "ENGINE_NOT_FOUND", "setChartType is unavailable on this engine", symbol);
    }
    stx.setChartType(params.chartType as string);
  } else {
    if (typeof stx.setAggregationType !== "function") {
      return makeError(id, "ENGINE_NOT_FOUND", "setAggregationType is unavailable on this engine", symbol);
    }
    stx.setAggregationType(params.aggregationType as string);
  }
  stx.draw?.();

  const chartType = layoutStr(stx.layout?.chartType);
  const aggregationType = layoutStr(stx.layout?.aggregationType);

  if (hasAggregationType && aggregationType !== params.aggregationType) {
    warnings.push(
      `requested aggregationType "${params.aggregationType}" did not stick — engine reports "${aggregationType}"`,
    );
  }
  if (hasChartType && beforeAggregation && beforeAggregation !== "ohlc" && aggregationType === "ohlc") {
    warnings.push(`chartType "${params.chartType}" reset aggregation to ohlc (was "${beforeAggregation}")`);
  }

  const result: SetChartStyleResult = { symbol, chartType, aggregationType };
  if (warnings.length) result.warnings = warnings;
  return { id, ok: true, symbol, data: result };
}

async function handleSetPeriodicity(id: string, params: SetPeriodicityParams): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (params.interval === undefined || params.interval === null || params.interval === "") {
    return makeError(id, "BAD_REQUEST", "interval is required", symbol);
  }
  if (typeof stx.setPeriodicity !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "setPeriodicity is unavailable on this engine", symbol);
  }

  const outcome = await awaitEngineReload(
    stx,
    (cb) =>
      stx.setPeriodicity!(
        { period: params.period ?? 1, interval: params.interval, timeUnit: params.timeUnit },
        cb,
      ),
    params.timeout_ms && params.timeout_ms > 0 ? params.timeout_ms : undefined,
  );

  if (outcome.timedOut) {
    return makeError(
      id,
      "TIMEOUT",
      `setPeriodicity did not complete within budget — snapshot: ${JSON.stringify({
        interval: params.interval,
        timeUnit: params.timeUnit ?? null,
        total_bars: outcome.total_bars,
      })}`,
      symbol,
    );
  }
  if (outcome.error) {
    return makeError(id, "INTERNAL", `setPeriodicity failed: ${outcome.error}`, symbol);
  }

  const warnings: string[] = [];
  if (!outcome.dataset_rebuilt) {
    warnings.push("dataSet reference did not change — periodicity may already have been active");
  }

  const result: SetPeriodicityResult = {
    symbol,
    interval: layoutStr(stx.layout?.interval),
    timeUnit: layoutStr(stx.layout?.timeUnit ?? null),
    periodicity: typeof stx.layout?.periodicity === "number" ? stx.layout.periodicity : null,
    total_bars: outcome.total_bars,
    dataset_rebuilt: outcome.dataset_rebuilt,
  };
  if (warnings.length) result.warnings = warnings;
  return { id, ok: true, symbol, data: result };
}

/** Parse a span shorthand like "1y" / "6m" / "5d" / "ytd" / "all" into ChartIQ's {multiplier, base}. */
function parseSpan(span: string): { multiplier: number; base: string } | { error: string } {
  const lower = span.trim().toLowerCase();
  if (lower === "ytd") return { multiplier: 1, base: "YTD" };
  if (lower === "all") return { multiplier: 1, base: "all" };
  const m = /^(\d+)([dwmy])$/.exec(lower);
  if (!m) {
    return { error: `could not parse span "${span}" — expected forms like "1y", "6m", "5d", "ytd", "all"` };
  }
  const multiplier = parseInt(m[1]!, 10);
  const unitMap: Record<string, string> = { d: "day", w: "week", m: "month", y: "year" };
  const base = unitMap[m[2]!];
  if (!base) return { error: `unknown span unit in "${span}"` };
  return { multiplier, base };
}

async function handleSetRange(id: string, params: SetRangeParams): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const hasSpan = typeof params.span === "string" && params.span.length > 0;
  const hasRange = typeof params.start === "string" && params.start && typeof params.end === "string" && params.end;
  if (!hasSpan && !hasRange) {
    return makeError(id, "BAD_REQUEST", "either span, or both start and end, are required", symbol);
  }

  let outcome: ReloadOutcome;
  if (hasSpan) {
    const parsed = parseSpan(params.span as string);
    if ("error" in parsed) return makeError(id, "BAD_REQUEST", parsed.error, symbol);
    if (typeof stx.setSpan !== "function") {
      return makeError(id, "ENGINE_NOT_FOUND", "setSpan is unavailable on this engine", symbol);
    }
    outcome = await awaitEngineReload(
      stx,
      (cb) => stx.setSpan!(parsed, cb),
      params.timeout_ms && params.timeout_ms > 0 ? params.timeout_ms : undefined,
    );
  } else {
    const dtLeft = new Date(params.start as string);
    const dtRight = new Date(params.end as string);
    if (Number.isNaN(dtLeft.getTime()) || Number.isNaN(dtRight.getTime())) {
      return makeError(id, "BAD_REQUEST", `could not parse start/end ("${params.start}" / "${params.end}")`, symbol);
    }
    if (typeof stx.setRange !== "function") {
      return makeError(id, "ENGINE_NOT_FOUND", "setRange is unavailable on this engine", symbol);
    }
    outcome = await awaitEngineReload(
      stx,
      (cb) => stx.setRange!({ dtLeft, dtRight }, cb),
      params.timeout_ms && params.timeout_ms > 0 ? params.timeout_ms : undefined,
    );
  }

  if (outcome.timedOut) {
    return makeError(
      id,
      "TIMEOUT",
      `setRange/setSpan did not complete within budget — snapshot: ${JSON.stringify({
        span: params.span ?? null,
        start: params.start ?? null,
        end: params.end ?? null,
        total_bars: outcome.total_bars,
      })}`,
      symbol,
    );
  }
  if (outcome.error) {
    return makeError(id, "INTERNAL", `setRange/setSpan failed: ${outcome.error}`, symbol);
  }

  const warnings: string[] = [];
  if (!outcome.dataset_rebuilt) {
    warnings.push("dataSet reference did not change — range may already have been active");
  }

  const dataSet = stx.chart?.dataSet;
  const first = Array.isArray(dataSet) ? toBar(dataSet[0]) : null;
  const last = Array.isArray(dataSet) && dataSet.length > 0 ? toBar(dataSet[dataSet.length - 1]) : null;

  const result: SetRangeResult = {
    symbol,
    interval: layoutStr(stx.layout?.interval),
    timeUnit: layoutStr(stx.layout?.timeUnit ?? null),
    total_bars: outcome.total_bars,
    range: { start: first?.date ?? null, end: last?.date ?? null },
    dataset_rebuilt: outcome.dataset_rebuilt,
  };
  if (warnings.length) result.warnings = warnings;
  return { id, ok: true, symbol, data: result };
}

async function handleAddComparison(id: string, params: AddComparisonParams): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.symbol !== "string" || !params.symbol) {
    return makeError(id, "BAD_REQUEST", "symbol is required", symbol);
  }
  const target = params.symbol.toUpperCase();
  if (stx.chart?.series && Object.prototype.hasOwnProperty.call(stx.chart.series, target)) {
    return makeError(id, "ALREADY_EXISTS", `comparison series "${target}" is already on the chart`, symbol);
  }
  if (typeof stx.addSeries !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "addSeries is unavailable on this engine", symbol);
  }

  const outcome = await awaitEngineReload(
    stx,
    (cb) => stx.addSeries!(target, { isComparison: true, color: params.color }, cb),
    params.timeout_ms && params.timeout_ms > 0 ? params.timeout_ms : undefined,
  );

  if (outcome.timedOut) {
    return makeError(
      id,
      "TIMEOUT",
      `addSeries did not complete within budget — snapshot: ${JSON.stringify({
        symbol: target,
        total_bars: outcome.total_bars,
      })}`,
      symbol,
    );
  }
  if (outcome.error) {
    return makeError(id, "INTERNAL", `addSeries failed: ${outcome.error}`, symbol);
  }

  const series = Object.keys(stx.chart?.series ?? {});
  const result: AddComparisonResult = {
    added: target,
    series,
    percent_axis: true,
    note:
      "adding a comparison switches the y-axis to a percentage scale; removing the last " +
      "comparison restores the linear price scale",
  };
  return { id, ok: true, symbol, data: result };
}

function handleRemoveComparison(id: string, params: RemoveComparisonParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.symbol !== "string" || !params.symbol) {
    return makeError(id, "BAD_REQUEST", "symbol is required", symbol);
  }
  const target = params.symbol.toUpperCase();
  if (typeof stx.removeSeries !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "removeSeries is unavailable on this engine", symbol);
  }

  stx.removeSeries(target);
  stx.draw?.();

  const series = Object.keys(stx.chart?.series ?? {});
  const result: RemoveComparisonResult = { removed: target, series, percent_axis: series.length > 0 };
  return { id, ok: true, symbol, data: result };
}

// --- Drawing tools (issues 002/003) ----------------------------------------

/**
 * ChartIQ stores a horizontal line's time anchor as `d0`, a "CIQ date" string
 * (YYYYMMDDHHmmssSSS) — the same format already sitting on each dataSet row's
 * `Date` field. A horizontal is conceptually price-only, but its adjust()
 * still calls setPoint() with d0 and throws if it's missing, so we MUST hand
 * it a real anchor. The most-recent bar's Date is the natural choice.
 */
function lastBarAnchor(dataSet: unknown[]): string | null {
  const lastRow = dataSet[dataSet.length - 1];
  if (lastRow && typeof lastRow === "object") {
    const d = (lastRow as Record<string, unknown>)["Date"];
    if (typeof d === "string" && d) return d;
  }
  return null;
}

/** Maps ChartIQ's terse serialized drawing into the AI-friendly shape. */
function toFriendlyDrawing(raw: Record<string, unknown>): FriendlyDrawing {
  const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    type: str(raw["name"]) ?? "unknown",
    price: numOf(raw["v0"]),
    color: str(raw["col"]),
    line_width: numOf(raw["lw"]),
    pattern: str(raw["ptrn"]),
    raw,
  };
}

function handleDrawSupport(id: string, params: DrawSupportParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const price = params.price;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return makeError(id, "BAD_REQUEST", "price must be a finite number", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }

  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }
  const d0 = lastBarAnchor(dataSet);
  if (!d0) {
    return makeError(id, "DATA_NOT_READY", "could not derive a time anchor from the latest bar", symbol);
  }

  const usedColor = params.color ?? "auto";
  const usedLineWidth = params.line_width && params.line_width > 0 ? params.line_width : 1;
  const panelName = stx.chart?.panel?.name ?? "chart";

  // Verified recipe (002, tested live): serialized keys (col/lw/ptrn), a real
  // d0 time anchor, and pnl so ChartIQ's reconstruct() binds+adjusts it. See
  // CLAUDE.md for why d0 + panelName/adjust are non-negotiable.
  const drawing = stx.createDrawing("horizontal", {
    pnl: panelName,
    v0: price,
    d0,
    col: usedColor,
    lw: usedLineWidth,
    ptrn: "solid",
  });
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  const mineRaw = exported.find((dobj) => dobj["name"] === "horizontal" && dobj["v0"] === price);
  const drawn: FriendlyDrawing = {
    type: "horizontal",
    price,
    color: usedColor,
    line_width: usedLineWidth,
    pattern: "solid",
    raw: mineRaw ?? { name: "horizontal", v0: price, col: usedColor, lw: usedLineWidth, ptrn: "solid" },
  };

  const result: DrawSupportResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, "horizontal"),
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

/** Successful result of {@link snapToNearestBar}. */
interface SnapResult {
  ciqDate: string;
  isoDate: string;
}

/**
 * Two-point drawings (trendline, fib) anchor on the CIQ `Date` string of a
 * specific loaded bar. A caller-supplied ISO-ish date is snapped to the
 * nearest loaded dataSet row. Dates before the earliest loaded bar are
 * rejected (ChartIQ silently clamps them to the left edge, misplacing the
 * drawing); dates after the last loaded bar are allowed (legit future
 * extrapolation).
 */
function snapToNearestBar(dataSet: unknown[], input: string): SnapResult | { error: string } {
  const targetTime = new Date(input).getTime();
  if (Number.isNaN(targetTime)) {
    return { error: `could not parse date "${input}"` };
  }

  const firstRow = dataSet[0];
  const firstDt =
    firstRow && typeof firstRow === "object" ? (firstRow as Record<string, unknown>)["DT"] : undefined;
  if (firstDt instanceof Date && !Number.isNaN(firstDt.getTime()) && targetTime < firstDt.getTime()) {
    return {
      error:
        `date ${input} is before the loaded range (earliest loaded bar is ${firstDt.toISOString()}); ` +
        "widen the chart's time range to load more history",
    };
  }

  let bestRow: Record<string, unknown> | null = null;
  let bestDiff = Infinity;
  for (const rawRow of dataSet) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const row = rawRow as Record<string, unknown>;
    const dt = row["DT"];
    if (!(dt instanceof Date)) continue;
    const t = dt.getTime();
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestRow = row;
    }
  }

  if (!bestRow) {
    return { error: "no usable bars in dataSet to snap to" };
  }
  const ciqDate = bestRow["Date"];
  if (typeof ciqDate !== "string" || !ciqDate) {
    return { error: "matched bar has no usable Date string to anchor the drawing" };
  }

  return { ciqDate, isoDate: extractDate(bestRow) };
}

function handleDrawTrendline(id: string, params: DrawTrendlineParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const { date1, price1, date2, price2 } = params;
  if (typeof price1 !== "number" || !Number.isFinite(price1)) {
    return makeError(id, "BAD_REQUEST", "price1 must be a finite number", symbol);
  }
  if (typeof price2 !== "number" || !Number.isFinite(price2)) {
    return makeError(id, "BAD_REQUEST", "price2 must be a finite number", symbol);
  }
  if (typeof date1 !== "string" || !date1) {
    return makeError(id, "BAD_REQUEST", "date1 is required", symbol);
  }
  if (typeof date2 !== "string" || !date2) {
    return makeError(id, "BAD_REQUEST", "date2 is required", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }

  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }

  const snap1 = snapToNearestBar(dataSet, date1);
  if ("error" in snap1) return makeError(id, "BAD_REQUEST", snap1.error, symbol);
  const snap2 = snapToNearestBar(dataSet, date2);
  if ("error" in snap2) return makeError(id, "BAD_REQUEST", snap2.error, symbol);

  const usedColor = params.color ?? "auto";
  const usedLineWidth = params.line_width && params.line_width > 0 ? params.line_width : 1;
  const panelName = stx.chart?.panel?.name ?? "chart";

  const drawing = stx.createDrawing("segment", {
    pnl: panelName,
    d0: snap1.ciqDate,
    v0: price1,
    d1: snap2.ciqDate,
    v1: price2,
    col: usedColor,
    lw: usedLineWidth,
    ptrn: "solid",
  });
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  const mineRaw = exported.find(
    (dobj) => dobj["name"] === "segment" && dobj["v0"] === price1 && dobj["v1"] === price2,
  );
  const drawn: FriendlyDrawing = {
    type: "segment",
    price: null,
    color: usedColor,
    line_width: usedLineWidth,
    pattern: "solid",
    raw: mineRaw ?? {
      name: "segment",
      v0: price1,
      d0: snap1.ciqDate,
      v1: price2,
      d1: snap2.ciqDate,
      col: usedColor,
      lw: usedLineWidth,
      ptrn: "solid",
    },
  };

  const result: DrawTrendlineResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, "segment"),
    snapped: { date1: snap1.isoDate, date2: snap2.isoDate },
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

function handleDrawFib(id: string, params: DrawFibParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const { date1, price1, date2, price2 } = params;
  if (typeof price1 !== "number" || !Number.isFinite(price1)) {
    return makeError(id, "BAD_REQUEST", "price1 must be a finite number", symbol);
  }
  if (typeof price2 !== "number" || !Number.isFinite(price2)) {
    return makeError(id, "BAD_REQUEST", "price2 must be a finite number", symbol);
  }
  if (typeof date1 !== "string" || !date1) {
    return makeError(id, "BAD_REQUEST", "date1 is required", symbol);
  }
  if (typeof date2 !== "string" || !date2) {
    return makeError(id, "BAD_REQUEST", "date2 is required", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }

  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }

  const snap1 = snapToNearestBar(dataSet, date1);
  if ("error" in snap1) return makeError(id, "BAD_REQUEST", snap1.error, symbol);
  const snap2 = snapToNearestBar(dataSet, date2);
  if ("error" in snap2) return makeError(id, "BAD_REQUEST", snap2.error, symbol);

  const usedColor = params.color ?? "auto";
  const panelName = stx.chart?.panel?.name ?? "chart";

  const drawing = stx.createDrawing("fibonacci", {
    pnl: panelName,
    col: usedColor,
    fc: usedColor,
    d0: snap1.ciqDate,
    v0: price1,
    d1: snap2.ciqDate,
    v1: price2,
  });
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  const mineRaw = exported.find(
    (dobj) => dobj["name"] === "fibonacci" && dobj["v0"] === price1 && dobj["v1"] === price2,
  );
  const drawn: FriendlyDrawing = {
    type: "fibonacci",
    price: null,
    color: usedColor,
    line_width: null,
    pattern: null,
    raw: mineRaw ?? {
      name: "fibonacci",
      v0: price1,
      d0: snap1.ciqDate,
      v1: price2,
      d1: snap2.ciqDate,
      col: usedColor,
      fc: usedColor,
    },
  };

  const result: DrawFibResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, "fibonacci"),
    snapped: { date1: snap1.isoDate, date2: snap2.isoDate },
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

function handleReadDrawings(id: string): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;
  if (typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }
  const exported = stx.exportDrawings();
  const drawings = exported.map(toFriendlyDrawing);
  const result: ReadDrawingsResult = { symbol, count: drawings.length, drawings };
  return { id, ok: true, symbol, data: result };
}

// --- Drawing families (issue 007) ------------------------------------------

/** Build a value fingerprint from an actual exported drawing (for later matching). */
function fingerprintOf(raw: Record<string, unknown> | undefined, name: string): DrawingMatch {
  const m: DrawingMatch = { name };
  if (raw) {
    if (typeof raw["v0"] === "number") m.v0 = raw["v0"] as number;
    if (typeof raw["v1"] === "number") m.v1 = raw["v1"] as number;
    if (typeof raw["d0"] === "string") m.d0 = raw["d0"] as string;
    if (typeof raw["d1"] === "string") m.d1 = raw["d1"] as string;
    const t = decodeText(raw["text"]);
    if (t !== null) m.text = t;
  }
  return m;
}

/** Generic two-point drawings sharing the segment recipe: ray / rectangle / channel. */
function handleDrawTwoPoint(id: string, ciqName: string, params: DrawTwoPointParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const { date1, price1, date2, price2 } = params;
  if (typeof price1 !== "number" || !Number.isFinite(price1)) {
    return makeError(id, "BAD_REQUEST", "price1 must be a finite number", symbol);
  }
  if (typeof price2 !== "number" || !Number.isFinite(price2)) {
    return makeError(id, "BAD_REQUEST", "price2 must be a finite number", symbol);
  }
  if (typeof date1 !== "string" || !date1 || typeof date2 !== "string" || !date2) {
    return makeError(id, "BAD_REQUEST", "date1 and date2 are required", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }
  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }
  const snap1 = snapToNearestBar(dataSet, date1);
  if ("error" in snap1) return makeError(id, "BAD_REQUEST", snap1.error, symbol);
  const snap2 = snapToNearestBar(dataSet, date2);
  if ("error" in snap2) return makeError(id, "BAD_REQUEST", snap2.error, symbol);

  const usedColor = params.color ?? "auto";
  const usedLineWidth = params.line_width && params.line_width > 0 ? params.line_width : 1;
  const panelName = stx.chart?.panel?.name ?? "chart";

  const createParams: Record<string, unknown> = {
    pnl: panelName,
    d0: snap1.ciqDate,
    v0: price1,
    d1: snap2.ciqDate,
    v1: price2,
    col: usedColor,
    lw: usedLineWidth,
    ptrn: "solid",
  };
  if (typeof params.fill_color === "string" && params.fill_color) createParams.fc = params.fill_color;

  const drawing = stx.createDrawing(ciqName, createParams);
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  const mineRaw = exported.find(
    (dobj) => dobj["name"] === ciqName && dobj["v0"] === price1 && dobj["v1"] === price2,
  );
  const drawn: FriendlyDrawing = {
    type: ciqName,
    price: null,
    color: usedColor,
    line_width: usedLineWidth,
    pattern: "solid",
    raw: mineRaw ?? { name: ciqName, v0: price1, v1: price2, col: usedColor, lw: usedLineWidth },
  };
  const result: DrawResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, ciqName),
    snapped: { date1: snap1.isoDate, date2: snap2.isoDate },
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

/** A vertical line anchored on a single date (price only positions the label). */
function handleDrawVertical(id: string, params: DrawVerticalParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.date !== "string" || !params.date) {
    return makeError(id, "BAD_REQUEST", "date is required", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }
  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }
  const snap = snapToNearestBar(dataSet, params.date);
  if ("error" in snap) return makeError(id, "BAD_REQUEST", snap.error, symbol);

  const usedColor = params.color ?? "auto";
  const usedLineWidth = params.line_width && params.line_width > 0 ? params.line_width : 1;
  const usedPattern = params.pattern ?? "solid";
  const panelName = stx.chart?.panel?.name ?? "chart";
  // A vertical is time-only; ChartIQ still wants a v0 to anchor the label. The
  // latest close is a stable, on-screen choice.
  const anchorPrice = toBar(dataSet[dataSet.length - 1])?.close ?? 0;

  const drawing = stx.createDrawing("vertical", {
    pnl: panelName,
    d0: snap.ciqDate,
    v0: anchorPrice,
    col: usedColor,
    lw: usedLineWidth,
    ptrn: usedPattern,
  });
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  const mineRaw = exported.find((dobj) => dobj["name"] === "vertical" && dobj["d0"] === snap.ciqDate);
  const drawn: FriendlyDrawing = {
    type: "vertical",
    price: null,
    color: usedColor,
    line_width: usedLineWidth,
    pattern: usedPattern,
    raw: mineRaw ?? { name: "vertical", d0: snap.ciqDate, col: usedColor, lw: usedLineWidth },
  };
  const result: DrawResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, "vertical"),
    snapped: { date1: snap.isoDate, date2: null },
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

/** A text callout (boxed) or annotation (borderless) anchored at (date, price). */
function handleDrawCallout(id: string, params: DrawCalloutParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.date !== "string" || !params.date) {
    return makeError(id, "BAD_REQUEST", "date is required", symbol);
  }
  if (typeof params.price !== "number" || !Number.isFinite(params.price)) {
    return makeError(id, "BAD_REQUEST", "price must be a finite number", symbol);
  }
  if (typeof params.text !== "string" || !params.text) {
    return makeError(id, "BAD_REQUEST", "text is required", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }
  const dataSet = stx.chart?.dataSet;
  if (!Array.isArray(dataSet) || dataSet.length === 0) {
    return makeError(id, "DATA_NOT_READY", "engine has no dataSet loaded yet", symbol);
  }
  const snap = snapToNearestBar(dataSet, params.date);
  if ("error" in snap) return makeError(id, "BAD_REQUEST", snap.error, symbol);

  const boxed = params.boxed !== false; // default boxed (callout)
  const ciqName = boxed ? "callout" : "annotation";
  const usedColor = params.color ?? "#000000";
  const panelName = stx.chart?.panel?.name ?? "chart";

  // ChartIQ stores text URL-encoded internally; passing the plain string is
  // correct (it round-trips to the plain text on render). Verified on live Yahoo.
  const drawing = stx.createDrawing(ciqName, {
    pnl: panelName,
    d0: snap.ciqDate,
    v0: params.price,
    text: params.text,
    col: usedColor,
  });
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  const mineRaw = exported.find(
    (dobj) => dobj["name"] === ciqName && dobj["v0"] === params.price && decodeText(dobj["text"]) === params.text,
  );
  const drawn: FriendlyDrawing = {
    type: ciqName,
    price: params.price,
    color: usedColor,
    line_width: null,
    pattern: null,
    raw: mineRaw ?? { name: ciqName, v0: params.price, text: params.text, col: usedColor },
  };
  const result: DrawResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, ciqName),
    snapped: { date1: snap.isoDate, date2: null },
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

/** Escape hatch: pass a ChartIQ tool name + serialized params straight through. */
function handleDrawRaw(id: string, params: DrawRawParams): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.type !== "string" || !params.type) {
    return makeError(id, "BAD_REQUEST", "type (ChartIQ tool name) is required", symbol);
  }
  if (!params.params || typeof params.params !== "object") {
    return makeError(id, "BAD_REQUEST", "params (serialized drawing fields) object is required", symbol);
  }
  if (typeof stx.createDrawing !== "function" || typeof stx.exportDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }

  const panelName = stx.chart?.panel?.name ?? "chart";
  const createParams: Record<string, unknown> = { pnl: panelName, ...params.params };
  const beforeCount = stx.exportDrawings().length;
  const drawing = stx.createDrawing(params.type, createParams);
  if (typeof drawing.adjust === "function") {
    drawing.panelName ??= panelName;
    drawing.adjust();
  }
  stx.draw?.();

  const exported = stx.exportDrawings();
  if (exported.length <= beforeCount) {
    return makeError(
      id,
      "BAD_REQUEST",
      `createDrawing("${params.type}", …) did not add a drawing — check the tool name/params ` +
        "(hand-draw it once on Yahoo, then read_drawings to harvest the exact serialized params)",
      symbol,
    );
  }
  const mineRaw = exported[exported.length - 1];
  const drawn = toFriendlyDrawing(mineRaw ?? { name: params.type });
  const result: DrawResult = {
    symbol,
    drawn,
    total_drawings: exported.length,
    fingerprint: fingerprintOf(mineRaw, params.type),
  };
  const hint = viewHint(symbol);
  if (hint !== undefined) result.view_hint = hint;
  return { id, ok: true, symbol, data: result };
}

// --- Defensive removal (issue 007, fixes the live Yahoo undo-manager bug) ---

/** Yahoo bolts a half-working undo manager onto ChartIQ; its removal calls
 *  throw this even though the drawing IS removed. We judge by exportDrawings. */
const IGNORABLE_REMOVE_ERR = /assertive\.nextPage is not a function/i;

function safeExport(stx: ChartIqEngine): Array<Record<string, unknown>> {
  try {
    return typeof stx.exportDrawings === "function" ? stx.exportDrawings() : [];
  } catch {
    return [];
  }
}

function decodeText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function drawingMatches(d: Record<string, unknown>, m: DrawingMatch): boolean {
  if (d["name"] !== m.name) return false;
  const near = (a: unknown, b: number) =>
    typeof a === "number" && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
  if (m.v0 !== undefined && !near(d["v0"], m.v0)) return false;
  if (m.v1 !== undefined && !near(d["v1"], m.v1)) return false;
  if (m.d0 !== undefined && d["d0"] !== m.d0) return false;
  if (m.d1 !== undefined && d["d1"] !== m.d1) return false;
  if (m.text !== undefined && decodeText(d["text"]) !== m.text) return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs a removal `mutate`, then judges success by an exportDrawings() recheck —
 * NOT by whether the call threw (Yahoo's patched undo manager throws even on a
 * successful remove). Rechecks immediately + after a short delay to catch
 * Yahoo's undo stack restoring the target, re-running `mutate` once if so.
 */
async function defensiveMutate(
  stx: ChartIqEngine,
  mutate: () => void,
  stillPresent: (exported: Array<Record<string, unknown>>) => boolean,
): Promise<{ warnings: string[]; restored: boolean }> {
  const warnings: string[] = [];
  const run = () => {
    try {
      mutate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!IGNORABLE_REMOVE_ERR.test(msg)) {
        warnings.push(`removal threw (non-fatal, verified via exportDrawings): ${msg}`);
      }
    }
    try {
      stx.draw?.();
    } catch {
      /* draw() can also throw through Yahoo's shim; the recheck is the source of truth */
    }
  };
  run();
  const present1 = stillPresent(safeExport(stx));
  await delay(200);
  let present2 = stillPresent(safeExport(stx));
  let restored = false;
  if (!present1 && present2) {
    restored = true;
    warnings.push("target reappeared after removal (Yahoo undo stack); re-removed");
    run();
    await delay(200);
    present2 = stillPresent(safeExport(stx));
  }
  if (present2) warnings.push("target still present after removal attempts");
  return { warnings, restored };
}

/** Remove every live drawing matching ANY of the given fingerprints (defensive). */
async function handleRemoveMatches(id: string, params: RemoveMatchesParams): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;
  if (typeof stx.exportDrawings !== "function" || typeof stx.removeDrawing !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ removal API unavailable on this engine", symbol);
  }
  const matches = Array.isArray(params.matches) ? params.matches : [];
  const isTarget = (d: Record<string, unknown>) => matches.some((m) => drawingMatches(d, m));
  const beforeCount = safeExport(stx).length;

  const removeWarnings: string[] = [];
  const { warnings, restored } = await defensiveMutate(
    stx,
    () => {
      const objs = Array.isArray(stx.drawingObjects) ? [...stx.drawingObjects] : [];
      for (const obj of objs) {
        const ser =
          obj && typeof (obj as { serialize?: () => Record<string, unknown> }).serialize === "function"
            ? (obj as { serialize: () => Record<string, unknown> }).serialize()
            : (obj as Record<string, unknown>);
        if (ser && isTarget(ser)) {
          try {
            stx.removeDrawing?.(obj);
          } catch (e) {
            // Swallow per-drawing errors and KEEP GOING — a non-ignorable throw
            // on one target must not skip the rest of the batch. Whether the
            // target actually went is decided by the exportDrawings recheck.
            const msg = e instanceof Error ? e.message : String(e);
            if (!IGNORABLE_REMOVE_ERR.test(msg)) {
              removeWarnings.push(`removeDrawing threw (verified via exportDrawings): ${msg}`);
            }
          }
        }
      }
    },
    (exported) => exported.some(isTarget),
  );
  warnings.push(...removeWarnings);

  const after = safeExport(stx);
  const result: RemovalResult = {
    symbol,
    removed: Math.max(0, beforeCount - after.length),
    remaining: after.length,
    restored,
  };
  if (warnings.length) result.warnings = warnings;
  return { id, ok: true, symbol, data: result };
}

/** Clear ALL drawings (incl. hand-drawn) via clearDrawings (defensive). */
async function handleClearAll(id: string): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;
  if (typeof stx.exportDrawings !== "function" || typeof stx.clearDrawings !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ drawing API unavailable on this engine", symbol);
  }
  const beforeCount = safeExport(stx).length;
  const { warnings, restored } = await defensiveMutate(
    stx,
    () => stx.clearDrawings?.(),
    (exported) => exported.length > 0,
  );
  const after = safeExport(stx);
  const result: RemovalResult = {
    symbol,
    removed: Math.max(0, beforeCount - after.length),
    remaining: after.length,
    restored,
  };
  if (warnings.length) result.warnings = warnings;
  return { id, ok: true, symbol, data: result };
}

/** Undo the most recent drawing via undoLast (defensive). */
async function handleUndo(id: string): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;
  if (typeof stx.exportDrawings !== "function" || typeof stx.undoLast !== "function") {
    return makeError(id, "ENGINE_NOT_FOUND", "ChartIQ undo API unavailable on this engine", symbol);
  }
  const beforeCount = safeExport(stx).length;
  const warnings: string[] = [];
  try {
    stx.undoLast?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!IGNORABLE_REMOVE_ERR.test(msg)) warnings.push(`undo threw (non-fatal, verified via exportDrawings): ${msg}`);
  }
  try {
    stx.draw?.();
  } catch {
    /* verified via recheck */
  }
  await delay(200);
  const after = safeExport(stx);
  const result: UndoDrawingResult = {
    symbol,
    removed: Math.max(0, beforeCount - after.length),
    remaining: after.length,
  };
  if (warnings.length) result.warnings = warnings;
  return { id, ok: true, symbol, data: result };
}

// --- Indicators (issue 009): runtime CIQ handle + Studies ------------------

/**
 * window.CIQ is unreachable (ChartIQ ships as a closure-private ES module).
 * The CIQ namespace is instead recovered at runtime by scanning every JS
 * module Yahoo has loaded (performance.getEntriesByType("resource")) and
 * dynamically import()-ing each one, looking for an export whose
 * .ChartEngine === stx.constructor (strongest signal) or, failing that, one
 * exposing .Studies.addStudy + .Studies.studyLibrary. Cached at module scope
 * once found — the CIQ namespace itself is stable even though symbol/period
 * changes rebuild the engine instance. Filenames/export names are Yahoo build
 * artifacts that vary per deploy; never hardcoded.
 */
let cachedCiq: any = null;

async function getCiqHandle(stx: ChartIqEngine): Promise<any | null> {
  if (cachedCiq) return cachedCiq;
  const ctor = (stx as unknown as { constructor: unknown }).constructor;
  // Scan newest-loaded first: the ChartIQ bundle loads well after the initial
  // page shell, so reversing usually finds CIQ within the first handful of
  // imports instead of after ~130. Each import is bounded by a short timeout so
  // one slow/hung resource can't stall the whole handler past the bridge budget.
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => /\.js(\?|$)/.test(u))
    .reverse();
  const importWithTimeout = (url: string, ms = 1500): Promise<any> =>
    Promise.race([
      import(/* @vite-ignore */ url),
      new Promise((_, rej) => setTimeout(() => rej(new Error("import timeout")), ms)),
    ]);
  for (const url of urls) {
    let mod: any;
    try {
      mod = await importWithTimeout(url);
    } catch {
      continue; // classic scripts / cross-origin / slow imports throw; skip
    }
    for (const key of Object.keys(mod)) {
      let exp: any;
      try {
        exp = mod[key];
      } catch {
        continue;
      }
      if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;
      try {
        if (exp.ChartEngine === ctor) {
          cachedCiq = exp;
          return exp;
        }
        if (exp.Studies && typeof exp.Studies.addStudy === "function" && exp.Studies.studyLibrary) {
          cachedCiq = exp;
          return exp;
        }
      } catch {
        /* prop access can throw on exotic exports */
      }
    }
  }
  return null;
}

/** Strip zero-width chars (U+200B/U+200C/U+200D/U+FEFF) Yahoo wraps active-study keys/names in. */
function stripZW(s: unknown): string {
  return String(s ?? "").replace(/[​‌‍﻿]/g, "");
}

/** stx.layout.studies is keyed by a zwnj-wrapped instance name; sd.type is clean. */
function activeStudies(stx: ChartIqEngine): ActiveStudy[] {
  const studies = stx.layout?.studies ?? {};
  return Object.entries(studies).map(([key, sd]) => ({
    name: stripZW(key),
    type: stripZW((sd as Record<string, unknown> | undefined)?.["type"]),
  }));
}

function ciqHandleError(id: string, symbol: string | null): ToolResponse {
  return makeError(
    id,
    "UNSUPPORTED_CIQ_HANDLE",
    "could not obtain a live CIQ module handle",
    symbol,
    "Yahoo may have changed its bundling; indicator features are unavailable.",
  );
}

async function handleListIndicators(id: string): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const ciq = await getCiqHandle(stx);
  if (!ciq) return ciqHandleError(id, symbol);

  const library = ciq.Studies?.studyLibrary ?? {};
  const available = Object.keys(library)
    .map((k) => stripZW(k))
    .sort();
  const result: ListIndicatorsResult = {
    symbol,
    available,
    available_count: available.length,
    active: activeStudies(stx),
  };
  return { id, ok: true, symbol, data: result };
}

async function handleAddIndicator(id: string, params: AddIndicatorParams): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.type !== "string" || !params.type) {
    return makeError(id, "BAD_REQUEST", "type is required", symbol);
  }

  const ciq = await getCiqHandle(stx);
  if (!ciq) return ciqHandleError(id, symbol);

  const library = ciq.Studies?.studyLibrary ?? {};
  const keys = Object.keys(library);
  const t = stripZW(params.type).toLowerCase();
  // Prefer an exact (normalized) key. Only fall back to substring when it is
  // UNAMBIGUOUS — a short type like "ma" that substring-matches several keys
  // ("MACross", "Mass Index", …) must NOT silently resolve to the wrong one.
  let key = keys.find((k) => stripZW(k).toLowerCase() === t);
  if (!key) {
    const subMatches = keys.filter((k) => stripZW(k).toLowerCase().includes(t));
    if (subMatches.length === 1) {
      key = subMatches[0];
    } else if (subMatches.length > 1) {
      return makeError(
        id,
        "BAD_REQUEST",
        `ambiguous indicator "${params.type}" matches ${subMatches.length} studies ` +
          `(${subMatches.map((k) => stripZW(k)).slice(0, 8).join(", ")}${subMatches.length > 8 ? ", …" : ""}) — ` +
          "use a more specific name from list_indicators",
        symbol,
      );
    }
  }
  if (!key) {
    return makeError(
      id,
      "BAD_REQUEST",
      `unknown indicator ${params.type} — call list_indicators for available names`,
      symbol,
    );
  }

  let sd: any;
  try {
    sd = ciq.Studies.addStudy(stx, key, params.inputs ?? {});
    stx.draw?.();
  } catch (e) {
    return makeError(id, "INTERNAL", e instanceof Error ? e.message : String(e), symbol);
  }

  const result: IndicatorResult = {
    symbol,
    added: stripZW(sd?.name ?? key),
    type: stripZW(sd?.type ?? key),
    active: activeStudies(stx),
  };
  return { id, ok: true, symbol, data: result };
}

async function handleRemoveIndicator(id: string, params: RemoveIndicatorParams): Promise<ToolResponse> {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  if (typeof params.type !== "string" || !params.type) {
    return makeError(id, "BAD_REQUEST", "type is required", symbol);
  }

  const ciq = await getCiqHandle(stx);
  if (!ciq) return ciqHandleError(id, symbol);

  const studies = stx.layout?.studies ?? {};
  const t = stripZW(params.type).toLowerCase();
  const values = Object.values(studies) as Array<Record<string, unknown>>;
  const target =
    values.find((sd) => stripZW(sd?.["type"]).toLowerCase() === t) ??
    values.find((sd) => stripZW(sd?.["name"]).toLowerCase().includes(t));
  if (!target) {
    return makeError(id, "BAD_REQUEST", `no active indicator matching ${params.type} — call list_indicators`, symbol);
  }

  try {
    ciq.Studies.removeStudy(stx, target);
    stx.draw?.();
  } catch (e) {
    return makeError(id, "INTERNAL", e instanceof Error ? e.message : String(e), symbol);
  }

  const result: IndicatorResult = {
    symbol,
    removed: stripZW(target["name"]),
    type: stripZW(target["type"]),
    active: activeStudies(stx),
  };
  return { id, ok: true, symbol, data: result };
}

// --- Corporate events (issue 009) -------------------------------------------

function handleGetCorporateEvents(id: string): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const stx = r.engine;
  const symbol = r.symbol;

  const md = stx.chart?.masterData;
  if (!Array.isArray(md) || md.length === 0) {
    const result: GetCorporateEventsResult = {
      symbol,
      count: 0,
      events_csv: "date,type,value",
      note: "no masterData loaded — switch to a daily periodicity first",
    };
    return { id, ok: true, symbol, data: result };
  }

  const rows: string[] = [];
  let count = 0;
  for (const rawRow of md) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const row = rawRow as Record<string, unknown>;
    const dt = row["DT"];
    const rowDate = dt instanceof Date ? dt.toISOString() : String(row["Date"] ?? "");

    const divs = row["divs"];
    if (divs != null) {
      const amount =
        typeof divs === "object" ? (divs as Record<string, unknown>)["amount"] : (divs as unknown);
      const value = typeof amount === "number" ? amount : Number(amount);
      rows.push(`${rowDate},dividend,${Number.isFinite(value) ? value : ""}`);
      count++;
    }
    const splits = row["splits"];
    if (splits != null) {
      // Splits may be a bare ratio number OR an object (Yahoo's shape isn't
      // guaranteed, and AAPL had none to harvest). Extract a sensible scalar,
      // else a compact comma-free string, so a split ratio is never silently
      // blanked. Any commas are stripped to keep the CSV columns intact.
      let raw: unknown = splits;
      if (typeof splits === "object") {
        const s = splits as Record<string, unknown>;
        raw = s["ratio"] ?? s["amount"] ?? (s["numerator"] != null ? `${s["numerator"]}:${s["denominator"]}` : JSON.stringify(splits));
      }
      const value = String(raw).replace(/,/g, " ");
      rows.push(`${rowDate},split,${value}`);
      count++;
    }
  }

  const events_csv = ["date,type,value", ...rows].join("\n");
  const result: GetCorporateEventsResult = {
    symbol,
    count,
    events_csv,
    note: "read from masterData rows; only populated in daily+ view; to annotate one on the chart use draw_callout",
  };
  return { id, ok: true, symbol, data: result };
}

/** Best-effort: click Yahoo's own corporate-events toolbar toggle, if we can find it. */
function handleToggleCorporateEvents(id: string): ToolResponse {
  const r = resolveEngine();
  if (!r.engine) return makeError(id, r.error_code, r.message, r.symbol, r.hint);
  const symbol = r.symbol;

  // Deliberately SPECIFIC: bare "events" matches too many unrelated controls
  // (news/earnings tabs, calendars) and this is a MUTATING click, so we only
  // match the specific corporate-events phrasings. Missing it → clean
  // UNSUPPORTED, which is far safer than clicking the wrong button.
  const pattern = /corporate event|dividends? (&|and|\/) split|show dividends|show splits/i;
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'));
  const el = candidates.find((c) => {
    const text = c.textContent ?? "";
    const aria = c.getAttribute("aria-label") ?? "";
    return pattern.test(text) || pattern.test(aria);
  }) as HTMLElement | undefined;

  if (!el) {
    return makeError(
      id,
      "UNSUPPORTED",
      "no corporate-events toggle button found in the current Yahoo layout",
      symbol,
      "Yahoo's toolbar may not expose this control on this page; read events with get_corporate_events instead.",
    );
  }

  const label = (el.textContent ?? el.getAttribute("aria-label") ?? "").trim();
  el.click();

  const result: ToggleCorporateEventsResult = { symbol, toggled: true, label };
  return { id, ok: true, symbol, data: result };
}

// --- Message plumbing ------------------------------------------------------

function route(request: {
  id: string;
  tool: string;
  params: Record<string, unknown>;
}): ToolResponse | Promise<ToolResponse> {
  switch (request.tool) {
    case "get_chart_data":
      return handleGetChartData(request.id, request.params as GetChartDataParams);
    case "get_chart_summary":
      return handleGetChartSummary(request.id);
    case "get_capabilities":
      return handleGetCapabilities(request.id);
    case "probe_ready":
      return handleProbeReady(request.id);
    case "draw_support":
      return handleDrawSupport(request.id, request.params as unknown as DrawSupportParams);
    case "draw_trendline":
      return handleDrawTrendline(request.id, request.params as unknown as DrawTrendlineParams);
    case "draw_fib":
      return handleDrawFib(request.id, request.params as unknown as DrawFibParams);
    case "draw_ray":
      return handleDrawTwoPoint(request.id, "ray", request.params as unknown as DrawTwoPointParams);
    case "draw_rectangle":
      return handleDrawTwoPoint(request.id, "rectangle", request.params as unknown as DrawTwoPointParams);
    case "draw_channel":
      return handleDrawTwoPoint(request.id, "channel", request.params as unknown as DrawTwoPointParams);
    case "draw_vertical":
      return handleDrawVertical(request.id, request.params as unknown as DrawVerticalParams);
    case "draw_callout":
      return handleDrawCallout(request.id, request.params as unknown as DrawCalloutParams);
    case "draw_raw":
      return handleDrawRaw(request.id, request.params as unknown as DrawRawParams);
    case "read_drawings":
      return handleReadDrawings(request.id);
    case "set_chart_style":
      return handleSetChartStyle(request.id, request.params as unknown as SetChartStyleParams);
    case "set_periodicity":
      return handleSetPeriodicity(request.id, request.params as unknown as SetPeriodicityParams);
    case "set_range":
      return handleSetRange(request.id, request.params as unknown as SetRangeParams);
    case "add_comparison":
      return handleAddComparison(request.id, request.params as unknown as AddComparisonParams);
    case "remove_comparison":
      return handleRemoveComparison(request.id, request.params as unknown as RemoveComparisonParams);
    case "list_indicators":
      return handleListIndicators(request.id);
    case "add_indicator":
      return handleAddIndicator(request.id, request.params as unknown as AddIndicatorParams);
    case "remove_indicator":
      return handleRemoveIndicator(request.id, request.params as unknown as RemoveIndicatorParams);
    case "get_corporate_events":
      return handleGetCorporateEvents(request.id);
    case "toggle_corporate_events":
      return handleToggleCorporateEvents(request.id);
    // Internal removal tools driven by the isolated-world persistence coordinator.
    case "_remove_matches":
      return handleRemoveMatches(request.id, request.params as unknown as RemoveMatchesParams);
    case "_clear_all":
      return handleClearAll(request.id);
    case "_undo":
      return handleUndo(request.id);
    default:
      return makeError(request.id, "BAD_REQUEST", `unknown tool: ${request.tool}`);
  }
}

// Install guard: Chrome injects this script declaratively on load, but
// open_chart may also programmatically (re)inject it to fix the "must refresh
// once to connect" case. Registering the message listener twice would answer
// every request twice, so we install exactly once per page.
declare global {
  interface Window {
    __YNF_MAIN_INSTALLED__?: boolean;
  }
}

if (!window.__YNF_MAIN_INSTALLED__) {
  window.__YNF_MAIN_INSTALLED__ = true;
  window.addEventListener("message", (event: MessageEvent) => {
    // Untrusted-input validation: MAIN world is shared with the host page.
    if (event.source !== window) return;
    const data = event.data as BridgeMessage | undefined;
    if (!data || data.ns !== BRIDGE_NS || data.dir !== "req") return;

    const request = data.payload;
    const post = (response: ToolResponse) =>
      window.postMessage({ ns: BRIDGE_NS, dir: "res", payload: response } satisfies BridgeMessage, "*");
    try {
      // route() may be sync or async (defensive removal does a delayed recheck).
      Promise.resolve(route(request))
        .then(post)
        .catch((err) => post(makeError(request.id, "INTERNAL", err instanceof Error ? err.message : String(err))));
    } catch (err) {
      post(makeError(request.id, "INTERNAL", err instanceof Error ? err.message : String(err)));
    }
  });
}
