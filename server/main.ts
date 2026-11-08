import { type StreamCacheOptions } from "./stream_cache.ts";
import page from "./web/index.html" with { type: "text" };
import app from "./web/app.js" with { type: "text" };
import arrowPageCache from "./web/arrow_page_cache.js" with { type: "text" };
import arrowTree from "./web/arrow_tree.js" with { type: "text" };
import resourceTree from "./web/resource_tree.js" with { type: "text" };
import styles from "./web/style.css" with { type: "text" };
import queryClient from "./web/jdv_query.js" with { type: "text" };
import sequentialClient from "./web/sequential.js" with { type: "text" };
import browserClient from "./web/client.js" with { type: "text" };
import tabulatorScript from "./web/vendor/tabulator.min.js" with {
  type: "text",
};
import tabulatorStyles from "./web/vendor/tabulator.min.css" with {
  type: "text",
};
import tabulatorLicense from "./web/vendor/TABULATOR-LICENSE.txt" with {
  type: "text",
};
import arrowScript from "./web/vendor/arrow-21.2.0.min.js" with {
  type: "text",
};
import arrowLicense from "./web/vendor/APACHE-ARROW-JS-LICENSE.txt" with {
  type: "text",
};
import arrowNotice from "./web/vendor/APACHE-ARROW-JS-NOTICE.txt" with {
  type: "text",
};
import { type BrowserClient, Hub } from "./hub.ts";
import { join } from "node:path";
import {
  cacheDirectory,
  listenProducer,
  preparePrivateDirectory,
  removeIfOwned,
  writeAtomicPrivate,
} from "./platform.ts";

interface Options extends StreamCacheOptions {
  mode: "default" | "tcp";
  httpPort: number;
  cacheDir: string;
  token?: string;
}

const encoder = new TextEncoder();
const MAX_BROWSER_MESSAGE_BYTES = 64 * 1024;
const MAX_BROWSER_BUFFERED_BYTES = 32 * 1024 * 1024;

interface BrowserSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(value: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export function createBrowserClient(
  socket: BrowserSocket,
  detach: (client: BrowserClient) => void,
): BrowserClient {
  let stopped = false;
  const stop = (code?: number, reason?: string) => {
    if (stopped) return;
    stopped = true;
    try {
      socket.close(code, reason);
    } finally {
      detach(client);
    }
  };
  const send = (value: string | Uint8Array, cacheReply: boolean) => {
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    // Cache reads bypass producer credit; limit only their additional send queue.
    if (cacheReply) {
      const bytes = typeof value === "string"
        ? encoder.encode(value).byteLength
        : value.byteLength;
      if (socket.bufferedAmount + bytes > MAX_BROWSER_BUFFERED_BYTES) {
        stop(1013, "Cache reply send queue limit exceeded");
        return;
      }
    }
    try {
      socket.send(value);
    } catch {
      stop();
    }
  };
  const client: BrowserClient = {
    send(value, cacheReply = false) {
      send(JSON.stringify(value), cacheReply);
    },
    sendBinary(bytes, cacheReply = false) {
      send(bytes, cacheReply);
    },
    close() {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) socket.close();
    },
  };
  return client;
}

export async function startServer(options: Options = parseOptions()): Promise<{
  url: string;
  socketPath: string;
  discoveryPath: string;
  close: () => Promise<void>;
}> {
  const hub = new Hub(options);
  await preparePrivateDirectory(options.cacheDir);
  const producerListener = await listenProducer({
    mode: options.mode,
    cacheDir: options.cacheDir,
  });
  let stopped = false;
  const instance = crypto.randomUUID();
  const pid = Deno.pid;

  const acceptLoop = (async () => {
    try {
      for await (const connection of producerListener.listener) {
        hub.acceptProducer(connection);
      }
    } catch (error) {
      if (!stopped) console.error(`Producer listener stopped: ${error}`);
    }
  })();
  let http: Deno.HttpServer | undefined;
  const discoveryPath = join(options.cacheDir, "discovery.json");
  let port = 0;
  let origin = "";
  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  const removeOwnSocket = async () => {
    if (!producerListener.socketPath.startsWith("unix://")) return;
    try {
      await Deno.remove(producerListener.socketPath.slice("unix://".length));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(`Could not remove producer socket: ${error}`);
      }
    }
  };

  try {
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => ready = resolve);
    http = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: options.httpPort,
        onListen(address) {
          port = address.port;
          origin = `http://127.0.0.1:${port}`;
          ready();
        },
        onError(error) {
          console.error(`HTTP request failed: ${error}`);
          return new Response("Internal server error", { status: 500 });
        },
      },
      (request) =>
        handleHttp(request, hub, { port, origin, token: options.token }),
    );
    await listening;
    const url = new URL(origin);
    if (options.token) url.searchParams.set("token", options.token);
    const advertisedUrl = url.href;
    await writeAtomicPrivate(
      discoveryPath,
      JSON.stringify({
        pid,
        instance,
        socketPath: producerListener.socketPath,
        httpUrl: advertisedUrl,
      }),
    );

    const close = async () => {
      if (stopped) return;
      stopped = true;
      if (onSigint) Deno.removeSignalListener("SIGINT", onSigint);
      if (onSigterm) Deno.removeSignalListener("SIGTERM", onSigterm);
      producerListener.listener.close();
      hub.close();
      await http!.shutdown();
      await removeIfOwned(discoveryPath, pid, instance);
      await removeOwnSocket();
      await acceptLoop;
    };

    onSigint = () =>
      void close().catch((error) => console.error(`Shutdown failed: ${error}`));
    Deno.addSignalListener("SIGINT", onSigint);
    if (Deno.build.os !== "windows") {
      onSigterm = () =>
        void close().catch((error) =>
          console.error(`Shutdown failed: ${error}`)
        );
      Deno.addSignalListener("SIGTERM", onSigterm);
    }
    console.log(
      JSON.stringify({
        url: advertisedUrl,
        socketPath: producerListener.socketPath,
        discoveryPath,
        pid,
      }),
    );
    void http.finished.catch((error) => {
      if (!stopped) console.error(`HTTP server stopped: ${error}`);
    });
    return {
      url: advertisedUrl,
      socketPath: producerListener.socketPath,
      discoveryPath,
      close,
    };
  } catch (error) {
    stopped = true;
    if (onSigint) Deno.removeSignalListener("SIGINT", onSigint);
    if (onSigterm) Deno.removeSignalListener("SIGTERM", onSigterm);
    producerListener.listener.close();
    hub.close();
    if (http) await http.shutdown().catch(() => undefined);
    await removeIfOwned(discoveryPath, pid, instance);
    await removeOwnSocket();
    await acceptLoop;
    throw error;
  }
}

function handleHttp(
  request: Request,
  hub: Hub,
  server: { port: number; origin: string; token?: string },
): Response {
  const host = request.headers.get("host");
  if (!validHost(host, server.port)) {
    return new Response("Invalid Host header", { status: 421 });
  }
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== server.origin) {
    return new Response("Invalid Origin header", { status: 403 });
  }

  const url = new URL(request.url);
  if (url.pathname === "/favicon.ico") {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "public, max-age=86400" },
    });
  }
  if (url.pathname === "/ws") {
    if (requestOrigin !== server.origin) {
      return new Response("Invalid Origin header", { status: 403 });
    }
    if (server.token && url.searchParams.get("token") !== server.token) {
      return new Response("Invalid viewer token", { status: 403 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.binaryType = "arraybuffer";
    const client = createBrowserClient(socket, (client) => hub.detach(client));
    socket.onopen = () => hub.attach(client);
    socket.onmessage = (event) => {
      if (
        typeof event.data !== "string" ||
        encoder.encode(event.data).byteLength > MAX_BROWSER_MESSAGE_BYTES
      ) {
        socket.close(1009, "Message is too large");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        socket.close(1007, "Invalid JSON");
        return;
      }
      if (!isObject(message)) {
        socket.close(1007, "Expected a JSON object");
        return;
      }
      hub.handleBrowser(client, message);
    };
    socket.onclose = () => hub.detach(client);
    socket.onerror = () => hub.detach(client);
    return response;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const assets: Record<string, { body: string; type: string }> = {
    "/": { body: page, type: "text/html; charset=utf-8" },
    "/index.html": { body: page, type: "text/html; charset=utf-8" },
    "/assets/app.js": { body: app, type: "text/javascript; charset=utf-8" },
    "/assets/arrow_page_cache.js": {
      body: arrowPageCache,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/arrow_tree.js": {
      body: arrowTree,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/resource_tree.js": {
      body: resourceTree,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/style.css": { body: styles, type: "text/css; charset=utf-8" },
    "/assets/sequential.js": {
      body: sequentialClient,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/client.js": {
      body: browserClient,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/jdv_query.js": {
      body: queryClient,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/vendor/tabulator.min.js": {
      body: tabulatorScript,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/vendor/tabulator.min.css": {
      body: tabulatorStyles,
      type: "text/css; charset=utf-8",
    },
    "/assets/vendor/TABULATOR-LICENSE.txt": {
      body: tabulatorLicense,
      type: "text/plain; charset=utf-8",
    },
    "/assets/vendor/arrow-21.2.0.min.js": {
      body: arrowScript,
      type: "text/javascript; charset=utf-8",
    },
    "/assets/vendor/APACHE-ARROW-JS-LICENSE.txt": {
      body: arrowLicense,
      type: "text/plain; charset=utf-8",
    },
    "/assets/vendor/APACHE-ARROW-JS-NOTICE.txt": {
      body: arrowNotice,
      type: "text/plain; charset=utf-8",
    },
  };
  const asset = assets[url.pathname];
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : asset.body, {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        `default-src 'self'; connect-src 'self' ws://127.0.0.1:${server.port}; style-src 'self'; script-src 'self'`,
    },
  });
}

function validHost(host: string | null, port: number): boolean {
  if (!host) return false;
  const accepted = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return accepted.has(host.toLowerCase());
}

export function parseOptions(args = Deno.args): Options {
  let mode: Options["mode"] = "default";
  let httpPort = 0;
  let cacheDir = Deno.env.get("JDV_CACHE_DIR") ?? cacheDirectory();
  let token: string | undefined;
  let streamCacheBytes: number | undefined;
  let streamCacheViewBytes: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--tcp") {
      mode = "tcp";
    } else if (arg === "--http-port") {
      httpPort = parsePort(args[++index], "HTTP port");
    } else if (arg === "--cache-dir") {
      const value = args[++index];
      if (!value) throw new Error("--cache-dir requires a path.");
      cacheDir = value;
    } else if (arg === "--stream-cache-bytes") {
      streamCacheBytes = parseCacheBytes(args[++index], arg);
    } else if (arg === "--stream-cache-view-bytes") {
      streamCacheViewBytes = parseCacheBytes(args[++index], arg);
    } else if (arg === "--token") {
      token = args[++index];
      if (!token || token.length < 16) {
        throw new Error("--token must contain at least 16 characters.");
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: deno run [permissions] <URL>/server/main.ts [--tcp] [--http-port PORT] [--cache-dir PATH] [--token TOKEN] [--stream-cache-bytes BYTES] [--stream-cache-view-bytes BYTES]",
      );
      Deno.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    mode,
    httpPort,
    cacheDir,
    token,
    streamCacheBytes,
    streamCacheViewBytes,
  };
}

function parseCacheBytes(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(
      `${label} requires a non-negative safe integer byte count.`,
    );
  }
  return Number(value);
}

function parsePort(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer from 0 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} must be an integer from 0 to 65535.`);
  }
  return port;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    await startServer();
  } catch (error) {
    console.error(error);
    Deno.exitCode = 1;
  }
}
