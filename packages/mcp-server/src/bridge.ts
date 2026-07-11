import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { makeError, type ToolRequest, type ToolResponse } from "@tratto/shared";

const DEFAULT_TIMEOUT_MS = 8000;

interface PendingEntry {
  resolve: (res: ToolResponse) => void;
  timer: NodeJS.Timeout;
}

/**
 * Request/response correlation between the MCP tool handlers and the single
 * extension WebSocket connection. Requests are matched to responses by id;
 * anything that doesn't come back within the timeout resolves (not rejects —
 * MCP tool calls should always get a well-formed ToolResponse) with a
 * TIMEOUT error so the caller gets a clean envelope either way.
 */
export class Bridge {
  private pending = new Map<string, PendingEntry>();
  private extensionSocket: WebSocket | null = null;

  /**
   * Called by ws-server when a new hello authenticates. If a different
   * socket was already registered, it's now stale (superseded, not merely
   * disconnected) — terminate it and fail any requests that were in flight
   * against it, since that old socket can never deliver a response.
   */
  setExtensionSocket(ws: WebSocket): void {
    const prev = this.extensionSocket;
    if (prev && prev !== ws) {
      try {
        prev.terminate();
      } catch {
        /* ignore */
      }
    }
    this.extensionSocket = ws;
    this.failAllPending("extension connection was replaced");
  }

  /**
   * Called by ws-server when a socket closes. Identity-guarded: only clears
   * the bridge's live socket if `ws` IS the currently-registered one — a
   * stale/superseded socket's late close must not null out a newer live
   * connection (this was the headline race bug).
   */
  clearExtensionSocket(ws: WebSocket): void {
    if (this.extensionSocket !== ws) return;
    this.extensionSocket = null;
    this.failAllPending("extension disconnected");
  }

  private failAllPending(message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(makeError(id, "NOT_READY", message));
    }
    this.pending.clear();
  }

  hasExtension(): boolean {
    return this.extensionSocket !== null && this.extensionSocket.readyState === WebSocket.OPEN;
  }

  /** Called by ws-server when a ToolResponse arrives from the extension. */
  resolveResponse(response: ToolResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return; // stale id (already timed out) or unknown — ignore
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    entry.resolve(response);
  }

  async sendToExtension(
    tool: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ToolResponse> {
    if (!this.hasExtension()) {
      return makeError(randomUUID(), "NO_TAB", "extension not connected");
    }

    const id = randomUUID();
    const request: ToolRequest = { id, tool, params };

    return new Promise<ToolResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(makeError(id, "TIMEOUT", `no response from extension within ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, timer });

      try {
        this.extensionSocket!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(makeError(id, "INTERNAL", err instanceof Error ? err.message : String(err)));
      }
    });
  }
}
