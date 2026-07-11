import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { SHARED_TOKEN, WS_PORT, type ToolResponse } from "@tratto/shared";
import type { Bridge } from "./bridge.js";

const HELLO_TIMEOUT_MS = 5000;
const KEEPALIVE_PING_INTERVAL_MS = 30000;

/**
 * Starts the local WebSocket server the extension dials into.
 *
 * Security model (dev-skeleton level, see CLAUDE.md "known risks"):
 * - Bound to 127.0.0.1 only — never reachable off-box.
 * - Origin header must start with "chrome-extension://" or the upgrade is
 *   refused outright (socket destroyed before the handshake completes).
 * - The first application message must be a valid {type:"hello", token}.
 *   Browser WebSocket clients can't set custom headers, so the token can't
 *   travel as an Authorization/Origin-style header — it has to be the first
 *   payload instead. It must NOT go in the URL (query strings end up in
 *   logs/history).
 * - Only after a valid hello does a socket become "the extension" and start
 *   receiving ToolRequests.
 */
export function startWsServer(bridge: Bridge): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const origin = request.headers.origin ?? "";
      if (!origin.startsWith("chrome-extension://")) {
        console.error(`[ws-server] rejected upgrade from origin: ${origin || "(none)"}`);
        socket.destroy();
        return;
      }
      // Logged so the user can later pin the exact extension id in a
      // tighter origin allowlist instead of accepting any chrome-extension://.
      console.error(`[ws-server] accepting upgrade from origin: ${origin}`);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws: WebSocket) => {
      let authenticated = false;
      let pingInterval: NodeJS.Timeout | null = null;
      let isAlive = true;

      const helloTimeout = setTimeout(() => {
        if (!authenticated) {
          console.error("[ws-server] closing socket: no hello received in time");
          ws.close();
        }
      }, HELLO_TIMEOUT_MS);

      // First message must be the hello/token handshake. Only after that do
      // we attach the steady-state message handler and register this socket
      // as "the extension" with the bridge.
      ws.once("message", (raw: RawData) => {
        clearTimeout(helloTimeout);

        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          console.error("[ws-server] closing socket: first message not valid JSON");
          ws.close();
          return;
        }

        const isValidHello =
          !!msg &&
          typeof msg === "object" &&
          (msg as { type?: unknown }).type === "hello" &&
          (msg as { token?: unknown }).token === SHARED_TOKEN;

        if (!isValidHello) {
          console.error("[ws-server] closing socket: invalid hello/token");
          ws.close();
          return;
        }

        authenticated = true;
        console.error("[ws-server] extension authenticated");
        // Only one extension connection is expected; a new valid hello
        // simply replaces whatever the bridge had before (the bridge itself
        // terminates the old socket and fails its in-flight requests).
        bridge.setExtensionSocket(ws);

        // Server-side pong liveness: a half-open/zombie connection (TCP RST
        // never arrives, or the extension process is frozen) will stop
        // answering pings without ever firing "close". Without this, ws.ping()
        // detects nothing on its own — we have to track the pong ourselves and
        // terminate() when a full interval passes with no reply.
        ws.on("pong", () => {
          isAlive = true;
        });

        pingInterval = setInterval(() => {
          if (!isAlive) {
            ws.terminate();
            return;
          }
          isAlive = false;
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, KEEPALIVE_PING_INTERVAL_MS);

        ws.on("message", (raw2: RawData) => handleAuthenticatedMessage(raw2, ws, bridge));
      });

      ws.on("close", () => {
        clearTimeout(helloTimeout);
        if (pingInterval) clearInterval(pingInterval);
        if (authenticated) {
          // Identity-guarded in the bridge: only clears the bridge's live
          // socket if `ws` is still the currently-registered one, so a stale
          // superseded socket's late close can't null out a newer connection.
          bridge.clearExtensionSocket(ws);
          console.error("[ws-server] extension disconnected");
        }
      });

      ws.on("error", (err) => {
        console.error("[ws-server] socket error:", err);
      });
    });

    httpServer.on("error", (err) => reject(err));

    httpServer.listen(WS_PORT, "127.0.0.1", () => {
      console.error(`[ws-server] listening on ws://127.0.0.1:${WS_PORT}`);
      resolve(() => {
        wss.close();
        httpServer.close();
      });
    });
  });
}

function handleAuthenticatedMessage(raw: RawData, ws: WebSocket, bridge: Bridge): void {
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return; // ignore malformed frames rather than tearing down the connection
  }
  if (!msg || typeof msg !== "object") return;

  const type = (msg as { type?: unknown }).type;
  if (type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }

  // Anything else with an id + ok flag is treated as a ToolResponse.
  if ("id" in msg && "ok" in msg) {
    bridge.resolveResponse(msg as ToolResponse);
  }
}
