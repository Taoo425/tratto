/**
 * Types for the popup <-> background status/control channel. Deliberately
 * kept local to the extension package (not in @tratto/shared) since these
 * never cross the WebSocket/MCP boundary — they're purely a
 * chrome.runtime.sendMessage contract between background.ts and popup.ts.
 */

export type WsState = "never" | "connecting" | "connected";

export type ChartUiState = "no_tab" | "loading" | "ready";

export interface ChartStatus {
  state: ChartUiState;
  tabId: number | null;
  windowId: number | null;
  /** Ticker symbol extracted from the tab URL, uppercased. */
  symbol: string | null;
  /** tab.title, best-effort company/page name. May be null. */
  title: string | null;
  /** Bars currently loaded in the engine's dataSet; 0 if unknown. */
  dataSetLen: number;
  /** How many Yahoo chart tabs are open (for the "AI only draws on this one" hint). */
  tabCount: number;
}

export interface GetStatusResult {
  ws: WsState;
  chart: ChartStatus;
}

export interface GetStatusMessage {
  type: "getStatus";
}

export interface FocusTabMessage {
  type: "focusTab";
  tabId: number;
  windowId: number;
}

export type PopupToBackgroundMessage = GetStatusMessage | FocusTabMessage;
