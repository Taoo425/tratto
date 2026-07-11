/**
 * Toolbar popup. Vanilla TS, no framework: `render(state)` rebuilds the whole
 * body's innerHTML from a `PopupState` object on every update (initial load,
 * each 2s poll, and local UI actions like copy/focus). Simplicity over
 * incremental-DOM cleverness — the popup is small and short-lived.
 */
import type {
  ChartStatus,
  ChartUiState,
  FocusTabMessage,
  GetStatusMessage,
  GetStatusResult,
  WsState,
} from "./popup-types";

const POLL_INTERVAL_MS = 2000;
const COPY_FEEDBACK_MS = 2000;

const CONFIG_COMMANDS = [
  { id: "claude", label: "Claude Code", cmd: "claude mcp add tratto -- npx -y tratto-mcp-server" },
  { id: "codex", label: "Codex", cmd: "codex mcp add tratto -- npx -y tratto-mcp-server" },
] as const;

interface PopupState {
  /** True until the first getStatus round-trip resolves (success or failure). */
  loading: boolean;
  /** True when background is unreachable (asleep/uninstalled) or sendMessage rejected. */
  error: boolean;
  status: GetStatusResult | null;
  /** Timestamp of the last successful clipboard copy, for the 2s "Copied" feedback window. */
  copiedAt: number | null;
  /** Which command was last copied ("claude" | "codex"), so only that button shows "Copied ✓". */
  copiedId: string | null;
  /**
   * User's explicit expand/collapse choice for the config <details>. null =
   * untouched (fall back to the per-ws default: open on first-run). We persist
   * this because render() rebuilds innerHTML wholesale on every 2s poll — without
   * it, a config block the user manually opened would slam shut each tick.
   */
  configOpen: boolean | null;
}

// --- hand-written 16px inline icons (no emoji, no external assets) ---------

const ICON_GEAR = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.3"/>
<path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.15 1.15M4.65 11.35L3.5 12.5M12.5 12.5l-1.15-1.15M4.65 4.65L3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;

const ICON_COPY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<rect x="5.6" y="5.6" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/>
<path d="M3.6 10.4H2.8a1.2 1.2 0 0 1-1.2-1.2V2.8a1.2 1.2 0 0 1 1.2-1.2h6.4a1.2 1.2 0 0 1 1.2 1.2v0.8" stroke="currentColor" stroke-width="1.3"/>
</svg>`;

const ICON_EXTERNAL = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path d="M6.9 3.6H3.9a1.1 1.1 0 0 0-1.1 1.1v7.4a1.1 1.1 0 0 0 1.1 1.1h7.4a1.1 1.1 0 0 0 1.1-1.1v-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<path d="M9.2 2.7h4.1v4.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M13 2.9L7.4 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// --- row copy, keyed by the exact state unions so this stays exhaustive ----

interface RowConfig {
  dotClass: string;
  main: string;
  sub: string;
}

const WS_ROW: Record<WsState, RowConfig> = {
  never: { dotClass: "dot-grey", main: "Not connected", sub: "No AI assistant has connected yet — follow the steps below to set it up" },
  connecting: { dotClass: "dot-warn", main: "Connecting…", sub: "Waiting for the local service to respond (127.0.0.1:8787)" },
  connected: { dotClass: "dot-ok", main: "Connected", sub: "AI assistant is ready" },
};

const CHART_ROW: Record<ChartUiState, RowConfig> = {
  no_tab: { dotClass: "dot-grey", main: "No chart page open", sub: "Open any stock's chart on finance.yahoo.com" },
  loading: { dotClass: "dot-warn", main: "Chart loading…", sub: "The page is still loading — wait a moment or refresh it" },
  ready: { dotClass: "dot-ok", main: "Ready", sub: "" },
};

function overallDotClass(status: GetStatusResult | null): string {
  if (!status) return "dot-grey";
  const { ws, chart } = status;
  // Both green → healthy. Fully idle first-run (nothing configured, no chart
  // open) → neutral grey. Everything else → amber "needs attention". We
  // deliberately never go red here: red is reserved for the toolbar badge's
  // one actionable event (a working connection that just dropped), so a benign
  // combo like "connected but no chart tab open yet" shouldn't look alarming.
  if (ws === "connected" && chart.state === "ready") return "dot-ok";
  if (ws === "never" && chart.state === "no_tab") return "dot-grey";
  return "dot-warn";
}

function header(status: GetStatusResult | null): string {
  return `
    <div class="header">
      <div class="header-left">
        ${ICON_GEAR}
        <span class="title">Yahoo Chart Assistant</span>
      </div>
      <span class="dot dot-sm ${overallDotClass(status)}"></span>
    </div>
  `;
}

function statusRow(cfg: RowConfig): string {
  return `
    <div class="row">
      <span class="dot ${cfg.dotClass}"></span>
      <div class="row-text">
        <div class="row-main">${escapeHtml(cfg.main)}</div>
        ${cfg.sub ? `<div class="row-sub">${escapeHtml(cfg.sub)}</div>` : ""}
      </div>
    </div>
  `;
}

function stockCard(chart: ChartStatus): string {
  const banner =
    chart.tabCount > 1
      ? `<div class="banner">${chart.tabCount} Yahoo chart pages are open — the AI draws only on this one:</div>`
      : "";

  if (chart.state !== "ready") {
    return `<div class="stock-card muted">${banner}<div class="muted-text">Not ready yet</div></div>`;
  }

  const symbolHtml = escapeHtml(chart.symbol ?? "—");
  const titleHtml = chart.title ? `<span class="stock-title">${escapeHtml(chart.title)}</span>` : "";
  const canFocus = chart.tabId != null && chart.windowId != null;

  return `
    <div class="stock-card">
      ${banner}
      <div class="stock-card-top">
        <div class="stock-symbol-wrap">
          <span class="stock-symbol">${symbolHtml}</span>
          ${titleHtml}
        </div>
        ${canFocus ? `<button id="focus-btn" class="btn-secondary">${ICON_EXTERNAL}Switch to it</button>` : ""}
      </div>
      <div class="stock-sub">The AI will draw on this chart</div>
      <div class="stock-sub-dim">${chart.dataSetLen} candles</div>
    </div>
  `;
}

function configBlock(ws: WsState, copiedId: string | null, configOpen: boolean | null): string {
  const isFirstRun = ws === "never";
  // Default open on first-run; otherwise honour the user's explicit toggle.
  const open = configOpen ?? isFirstRun;
  const summaryText = isFirstRun ? "First time? Add tratto to your coding agent:" : "⚙ How to configure / reconfigure";

  const items = CONFIG_COMMANDS.map(({ id, label, cmd }) => {
    const btnInner = copiedId === id ? "Copied ✓" : `${ICON_COPY}Copy`;
    return `
        <div class="config-item">
          <div class="config-label">${label}</div>
          <div class="code-block">
            <pre>${escapeHtml(cmd)}</pre>
            <button data-copy="${id}" class="btn-secondary">${btnInner}</button>
          </div>
        </div>`;
  }).join("");

  return `
    <details class="config-details" ${open ? "open" : ""}>
      <summary>${summaryText}</summary>
      <div class="config-body">
        ${items}
        <div class="config-note">No install needed — <code>npx</code> fetches the server automatically. Then open a Yahoo Finance chart and ask the AI to read it; that connects the extension.</div>
      </div>
    </details>
  `;
}

function footer(): string {
  const version = escapeHtml(chrome.runtime.getManifest().version);
  return `
    <div class="footer">
      <span class="version">v${version}</span>
      <button id="refresh-btn" class="link-btn">Refresh</button>
    </div>
  `;
}

function fallbackBody(): string {
  return `
    <div class="fallback">
      <div>Status unavailable — the background may be asleep or the extension was just installed.</div>
      <button id="retry-btn" class="btn-secondary">Refresh</button>
    </div>
  `;
}

function buildHtml(state: PopupState): string {
  if (state.loading) {
    return `
      <div class="popup">
        ${header(null)}
        <div class="fallback"><div>Loading status…</div></div>
      </div>
    `;
  }

  if (state.error || !state.status) {
    return `
      <div class="popup">
        ${header(null)}
        ${fallbackBody()}
        ${footer()}
      </div>
    `;
  }

  const { ws, chart } = state.status;
  const copiedId = state.copiedAt != null && Date.now() - state.copiedAt < COPY_FEEDBACK_MS ? state.copiedId : null;

  return `
    <div class="popup">
      ${header(state.status)}
      <div class="rows">
        ${statusRow(WS_ROW[ws])}
        ${statusRow(CHART_ROW[chart.state])}
      </div>
      ${stockCard(chart)}
      ${configBlock(ws, copiedId, state.configOpen)}
      ${footer()}
    </div>
  `;
}

async function handleCopy(state: PopupState, id: string): Promise<void> {
  const entry = CONFIG_COMMANDS.find((c) => c.id === id);
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.cmd);
  } catch {
    return; // clipboard permission denied/unavailable — leave the button as-is
  }
  state.copiedAt = Date.now();
  state.copiedId = id;
  render(state);
  setTimeout(() => {
    // Only clear if a newer copy hasn't already reset the timer.
    if (state.copiedAt != null && Date.now() - state.copiedAt >= COPY_FEEDBACK_MS) {
      state.copiedAt = null;
      state.copiedId = null;
      render(state);
    }
  }, COPY_FEEDBACK_MS + 50);
}

function attachListeners(state: PopupState): void {
  document.getElementById("refresh-btn")?.addEventListener("click", () => void fetchAndRender(state));
  document.getElementById("retry-btn")?.addEventListener("click", () => void fetchAndRender(state));
  document.querySelectorAll<HTMLElement>("[data-copy]").forEach((el) =>
    el.addEventListener("click", () => void handleCopy(state, el.dataset.copy ?? "")),
  );

  // Persist the user's manual expand/collapse so the next 2s re-render doesn't
  // reset it (the whole body is rebuilt each poll). The toggle handler only
  // mutates state — no re-render — so there's no fight with the user's click.
  const details = document.querySelector<HTMLDetailsElement>(".config-details");
  details?.addEventListener("toggle", () => {
    state.configOpen = details.open;
  });

  const focusBtn = document.getElementById("focus-btn");
  const chart = state.status?.chart;
  if (focusBtn && chart?.tabId != null && chart.windowId != null) {
    const msg: FocusTabMessage = { type: "focusTab", tabId: chart.tabId, windowId: chart.windowId };
    focusBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage(msg).catch(() => {});
    });
  }
}

function render(state: PopupState): void {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = buildHtml(state);
  attachListeners(state);
}

async function fetchAndRender(state: PopupState): Promise<void> {
  try {
    const msg: GetStatusMessage = { type: "getStatus" };
    const result = (await chrome.runtime.sendMessage(msg)) as GetStatusResult | undefined;
    if (result) {
      state.status = result;
      state.error = false;
    } else {
      state.status = null;
      state.error = true;
    }
  } catch {
    // Background service worker asleep/unreachable — surface the neutral
    // fallback rather than throwing (popups have no error boundary).
    state.status = null;
    state.error = true;
  }
  state.loading = false;
  render(state);
}

const state: PopupState = { loading: true, error: false, status: null, copiedAt: null, copiedId: null, configOpen: null };
render(state);
void fetchAndRender(state);
setInterval(() => void fetchAndRender(state), POLL_INTERVAL_MS);
