import { assert } from "./assert.ts";
import { type ArfEvalResult, ArfSession } from "./helpers/arf_session.ts";
import {
  finishIntegrationCleanup,
  removeCacheDirectory,
} from "./integration_cleanup.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface WireFrame {
  direction: "to-r" | "from-r";
  time: number;
  value: Record<string, unknown>;
}

class FrameLog {
  readonly frames: WireFrame[] = [];
  #waiters: Array<() => void> = [];

  add(direction: WireFrame["direction"], value: Record<string, unknown>): void {
    this.frames.push({ direction, time: performance.now(), value });
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async waitFor(
    predicate: (frame: WireFrame) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<WireFrame> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}.`);
      }
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        delay(remaining).then(() => undefined),
      ]);
    }
  }
}

class BrowserMessages {
  readonly messages: Array<{
    value: Record<string, unknown>;
    time: number;
  }> = [];
  #waiters: Array<() => void> = [];
  #readError: Error | undefined;

  add(value: Record<string, unknown>): void {
    this.messages.push({ value, time: performance.now() });
    for (const wake of this.#waiters.splice(0)) wake();
  }

  fail(error: Error): void {
    this.#readError = error;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<{ value: Record<string, unknown>; time: number }> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (this.#readError) {
        throw new Error(`WebSocket reader stopped: ${this.#readError.message}`);
      }
      const found = this.messages.find((message) => predicate(message.value));
      if (found) return found;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}.`);
      }
      await Promise.race([
        new Promise<void>((resolve) => this.#waiters.push(resolve)),
        delay(remaining).then(() => undefined),
      ]);
    }
  }
}

class RawWebSocket {
  readonly #connection: Deno.Conn;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #closed = false;

  private constructor(connection: Deno.Conn) {
    this.#connection = connection;
    this.#reader = connection.readable.getReader();
  }

  static async connect(url: string): Promise<RawWebSocket> {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const connection = await Deno.connect({ hostname: "127.0.0.1", port });
    const client = new RawWebSocket(connection);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const key = btoa(String.fromCharCode(...nonce));
    await writeAll(
      connection,
      encoder.encode(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${parsed.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    const headers = await client.#readHeaders();
    if (!headers.startsWith("HTTP/1.1 101 ")) {
      throw new Error(`WebSocket upgrade failed: ${headers.split("\r\n")[0]}`);
    }
    const accept = headers.match(/\r\nsec-websocket-accept:\s*(.+)\r\n/i)?.[1];
    const digest = await crypto.subtle.digest(
      "SHA-1",
      encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
    assert(accept === expected, "The WebSocket accept value was invalid.");
    return client;
  }

  async read(): Promise<Record<string, unknown>> {
    const fragments: Uint8Array[] = [];
    let fragmented = false;
    for (;;) {
      const frame = await this.#readFrame();
      if (frame.opcode === 0x9) {
        await this.#sendFrame(0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x8) {
        throw new Error("The server closed the WebSocket connection.");
      }
      if (frame.opcode === 0x1) {
        if (fragmented) {
          throw new Error("A text frame interrupted a fragmented message.");
        }
        if (frame.final) {
          return JSON.parse(decoder.decode(frame.payload));
        }
        fragments.push(frame.payload);
        fragmented = true;
        continue;
      }
      if (frame.opcode === 0x0 && fragmented) {
        fragments.push(frame.payload);
        if (frame.final) {
          return JSON.parse(decoder.decode(concat(...fragments)));
        }
        continue;
      }
      throw new Error(`Unexpected WebSocket opcode ${frame.opcode}.`);
    }
  }

  async send(value: Record<string, unknown>): Promise<void> {
    const payload = encoder.encode(JSON.stringify(value));
    const mask = crypto.getRandomValues(new Uint8Array(4));
    let header: Uint8Array;
    if (payload.length < 126) {
      header = new Uint8Array([0x81, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = new Uint8Array([
        0x81,
        0xfe,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
      ]);
    } else {
      throw new Error("WebSocket request is too large for this test.");
    }
    const masked = payload.map((byte, index) => byte ^ mask[index % 4]);
    await writeAll(this.#connection, concat(header, mask, masked));
  }

  close(): void {
    this.#closed = true;
    try {
      this.#connection.close();
    } catch {
      // Closing test sockets is idempotent.
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #sendFrame(opcode: number, payload: Uint8Array): Promise<void> {
    if (opcode >= 0x8 && payload.length > 125) {
      throw new Error("WebSocket control payload exceeds 125 bytes.");
    }
    let header: Uint8Array;
    if (payload.length < 126) {
      header = new Uint8Array([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = new Uint8Array([
        0x80 | opcode,
        0xfe,
        (payload.length >>> 8) & 0xff,
        payload.length & 0xff,
      ]);
    } else {
      throw new Error("WebSocket frame is too large for this test.");
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const masked = payload.map((byte, index) => byte ^ mask[index % 4]);
    await writeAll(this.#connection, concat(header, mask, masked));
  }

  async #readFrame(): Promise<{
    final: boolean;
    opcode: number;
    payload: Uint8Array;
  }> {
    const header = await this.#readExact(2);
    const final = (header[0] & 0x80) !== 0;
    const opcode = header[0] & 0x0f;
    if ((header[0] & 0x70) !== 0) {
      throw new Error("Unexpected WebSocket reserved bits.");
    }
    if ((header[1] & 0x80) !== 0) {
      throw new Error("Server WebSocket frames must not be masked.");
    }
    let length = header[1] & 0x7f;
    if (length === 126) {
      const extended = await this.#readExact(2);
      length = (extended[0] << 8) | extended[1];
    } else if (length === 127) {
      const extended = await this.#readExact(8);
      const size = new DataView(extended.buffer, extended.byteOffset)
        .getBigUint64(0, false);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket message is too large for this test.");
      }
      length = Number(size);
    }
    if (opcode >= 0x8 && (!final || length > 125)) {
      throw new Error(
        "Invalid fragmented or oversized WebSocket control frame.",
      );
    }
    return { final, opcode, payload: await this.#readExact(length) };
  }

  async #readHeaders(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 16 * 1024) {
      bytes.push((await this.#readExact(1))[0]);
      const length = bytes.length;
      if (
        length >= 4 && bytes[length - 4] === 13 && bytes[length - 3] === 10 &&
        bytes[length - 2] === 13 && bytes[length - 1] === 10
      ) return decoder.decode(new Uint8Array(bytes));
    }
    throw new Error("WebSocket response headers exceeded 16 KiB.");
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const next = await this.#reader.read();
      if (next.done) {
        throw new Error("WebSocket connection closed unexpectedly.");
      }
      this.#buffer = concat(this.#buffer, next.value);
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
}

class SocketFrameReader {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(private readonly connection: Deno.Conn) {}

  async readHeaders(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 16 * 1024) {
      bytes.push((await this.#readExact(1))[0]);
      const length = bytes.length;
      if (
        length >= 4 && bytes[length - 4] === 13 && bytes[length - 3] === 10 &&
        bytes[length - 2] === 13 && bytes[length - 1] === 10
      ) return decoder.decode(new Uint8Array(bytes));
    }
    throw new Error("Test WebSocket handshake exceeded 16 KiB.");
  }

  async readFrame(): Promise<{ opcode: number; payload: Uint8Array }> {
    const header = await this.#readExact(2);
    const opcode = header[0] & 0x0f;
    const length = header[1] & 0x7f;
    assert((header[1] & 0x80) !== 0, "Client WebSocket frame was not masked.");
    assert(
      length < 126,
      "Test client frame unexpectedly used an extended length.",
    );
    const mask = await this.#readExact(4);
    const payload = await this.#readExact(length);
    return {
      opcode,
      payload: payload.map((byte, index) => byte ^ mask[index % 4]),
    };
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const chunk = new Uint8Array(4 * 1024);
      const count = await this.connection.read(chunk);
      if (count === null) throw new Error("Test WebSocket socket closed.");
      this.#buffer = concat(this.#buffer, chunk.subarray(0, count));
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
}

Deno.test({
  name: "interactive R resumes queued requests after sleep and browser frames",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
    const cacheRoot = await Deno.makeTempDir({
      prefix: "jdv-interactive-cache-",
    });
    const serverCache = `${cacheRoot}/server`;
    await Deno.mkdir(serverCache, { recursive: true });
    const markerDirs: string[] = [];

    let server:
      | Awaited<ReturnType<typeof import("../main.ts").startServer>>
      | undefined;
    let proxy: Deno.Listener | undefined;
    let proxyTask: Promise<void> | undefined;
    let browser: RawWebSocket | undefined;
    let arf: ArfSession | undefined;
    const proxyConnections = new Set<Deno.Conn>();
    const proxyErrors: string[] = [];
    const markerObservers: Array<{
      controller: AbortController;
      observation: Promise<MarkerObservation>;
    }> = [];
    let fallbackSleepReleasePath: string | undefined;
    let primaryError: unknown;

    try {
      const { startServer } = await import("../main.ts");
      server = await startServer({
        mode: "tcp",
        httpPort: 0,
        cacheDir: serverCache,
      });
      const target = new URL(server.socketPath);
      assert(
        target.protocol === "tcp:",
        "The actual server did not expose TCP.",
      );
      proxy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const proxyPort = (proxy.addr as Deno.NetAddr).port;
      const frameLog = new FrameLog();
      proxyTask = (async () => {
        for await (const incoming of proxy!) {
          proxyConnections.add(incoming);
          const upstream = await Deno.connect({
            hostname: target.hostname,
            port: Number(target.port),
          });
          proxyConnections.add(upstream);
          void Promise.all([
            forward(incoming, upstream, "from-r", frameLog),
            forward(upstream, incoming, "to-r", frameLog),
          ])
            .catch((error) => proxyErrors.push(String(error)))
            .finally(() => {
              proxyConnections.delete(incoming);
              proxyConnections.delete(upstream);
              closeQuietly(incoming);
              closeQuietly(upstream);
            });
        }
      })();

      browser = await RawWebSocket.connect(server.url);
      const browserMessages = new BrowserMessages();
      void (async () => {
        try {
          for (;;) browserMessages.add(await browser!.read());
        } catch (error) {
          if (!browser!.closed) {
            browserMessages.fail(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      })();
      await browserMessages.waitFor(
        (message) => message.type === "welcome",
        5_000,
        "viewer welcome",
      );

      const env = Deno.env.toObject();
      env.XDG_CACHE_HOME = cacheRoot;
      env.JDV_ADDRESS = `tcp://127.0.0.1:${proxyPort}`;
      // The console EOF diagnostic is emitted at the sys module's
      // debug level. Keep that evidence enabled for this test session.
      env.RUST_LOG ??= "arf_libr::sys=debug";
      if (testLibrary) env.R_LIBS_USER = testLibrary;
      arf = new ArfSession();
      await arf.start({ env });
      const interactive = await arf.eval("interactive()");
      assert(
        interactive.value?.includes("TRUE"),
        `Arf did not start an interactive R session: ${
          JSON.stringify(interactive)
        }`,
      );
      if (testLibrary) {
        await arf.eval(
          `.libPaths(c(${
            rQuote(testLibrary)
          }, .libPaths())); library(jdv, lib.loc = ${rQuote(testLibrary)})`,
        );
      } else {
        await arf.eval("library(jdv)");
      }
      await arf.eval(
        'id <- jdv_view(data.frame(x = 1:1000), mode = "paged")',
      );
      const opened = await browserMessages.waitFor(
        (message) => message.type === "view/open",
        10_000,
        "R view/open event",
      );
      const openMessage = opened.value;
      const session = String(openMessage.session);
      const openEnvelope = openMessage.message as Record<string, unknown>;
      const openParams = openEnvelope.params as Record<string, unknown>;
      const table = String(openParams.view);
      const generation = Number(openParams.generation);
      assert(session.startsWith("r-"), "R did not announce its real session.");
      assert(
        table.length > 0 && generation === 1,
        "The paged table was invalid.",
      );

      const sendRows = async (id: string, offset: number) => {
        await sendRequest(id, "grid/rows", {
          view: table,
          generation,
          offset,
          limit: 1,
        });
      };
      const sendSchema = async (id: string) => {
        await sendRequest(id, "view/schema", { view: table, generation });
      };
      const sendRequest = async (
        id: string,
        method: string,
        params: Record<string, unknown>,
      ) => {
        await browser!.send({
          type: "request",
          id,
          session,
          method,
          params,
        });
      };
      const rRequest = (offset: number) => (frame: WireFrame) =>
        frame.direction === "to-r" && frame.value.method === "grid/rows" &&
        (frame.value.params as Record<string, unknown> | undefined)?.offset ===
          offset;
      const rSchemaRequest = (after: number) => (frame: WireFrame) =>
        frame.time >= after && frame.direction === "to-r" &&
        frame.value.method === "view/schema" &&
        (frame.value.params as Record<string, unknown> | undefined)?.view ===
          table;
      const terminal = (wireId: string) => (frame: WireFrame) =>
        frame.direction === "from-r" && frame.value.id === wireId &&
        ("result" in frame.value || "error" in frame.value);
      const response = (id: string) => (message: Record<string, unknown>) =>
        message.type === "response" && message.id === id;

      const idleSchemaId = "interactive-top-level-idle-schema";
      const idleSchemaStartedAt = performance.now();
      await sendSchema(idleSchemaId);
      await frameLog.waitFor(
        rSchemaRequest(idleSchemaStartedAt),
        5_000,
        "top-level idle schema request on the R TCP stream",
      );
      await browserMessages.waitFor(
        response(idleSchemaId),
        5_000,
        "top-level idle schema response",
      );
      console.log(
        "interactive top-level idle schema round trip: " +
          (performance.now() - idleSchemaStartedAt).toFixed(0) + " ms",
      );

      const sleepId = "interactive-sleep-rows";
      const sleepCommandTime = performance.now();
      const sleepMarker = await markerPath();
      markerDirs.push(sleepMarker.directory);
      const sleepStartedPath = `${sleepMarker.directory}/started`;
      const sleepDonePath = `${sleepMarker.directory}/done`;
      const sleepObserverController = new AbortController();
      const sleepCompletionMarkerObserved = observeMarker(
        arf,
        sleepDonePath,
        20_000,
        sleepObserverController.signal,
      );
      markerObservers.push({
        controller: sleepObserverController,
        observation: sleepCompletionMarkerObserved,
      });
      const sleeping = arf.send(
        `writeLines("SLEEP_STARTED", ${
          rQuote(sleepStartedPath)
        }); Sys.sleep(10); writeLines("SLEEP_DONE", ${rQuote(sleepDonePath)})`,
        { timeoutMs: 15_000 },
      );
      await arf.waitForFile(sleepStartedPath);
      await delay(500);
      await sendRows(sleepId, 0);
      await frameLog.waitFor(
        rRequest(0),
        5_000,
        "sleep page request on the R TCP stream",
      );
      await delay(1_000);
      assert(
        !browserMessages.messages.some((message) =>
          response(sleepId)(message.value)
        ),
        "The sleep request unexpectedly ran while R was inside Sys.sleep().",
      );
      const sleepResult = await sleeping.wait(17_000);
      assert(
        sleepResult.error === null,
        `R sleep evaluation failed: ${sleepResult.error}`,
      );
      const sleepCompletionMarkerAt = await markerTime(
        sleepCompletionMarkerObserved,
      );
      assert(
        await fileExists(sleepDonePath, "SLEEP_DONE"),
        "R did not write the sleep completion marker.",
      );
      const sleepResponse = await browserMessages.waitFor(
        response(sleepId),
        1_000,
        "automatic response after the SLEEP_DONE marker",
      );
      const sleepDelay = sleepResponse.time - sleepCompletionMarkerAt;
      assert(
        sleepDelay <= 1_000,
        `Sleep response arrived ${
          sleepDelay.toFixed(0)
        } ms after the SLEEP_DONE marker was observed.`,
      );
      console.log(
        `interactive regression: response after SLEEP_DONE marker in ${
          sleepDelay.toFixed(0)
        } ms (command ${
          ((sleepCompletionMarkerAt - sleepCommandTime) / 1000).toFixed(2)
        } s)`,
      );

      const browserMarkers = await markerPath();
      markerDirs.push(browserMarkers.directory);
      const browserStartedPath = `${browserMarkers.directory}/started`;
      const browserDonePath = `${browserMarkers.directory}/done`;
      const browserFrameProbePath = `${browserMarkers.directory}/frame-depth`;
      const browserObserverController = new AbortController();
      const browserCompletionMarkerObserved = observeMarker(
        arf,
        browserDonePath,
        70_000,
        browserObserverController.signal,
      );
      markerObservers.push({
        controller: browserObserverController,
        observation: browserCompletionMarkerObserved,
      });
      const browserLogBefore = await arf.readLog();
      const browserEvaluation = arf.send(
        `local({ writeLines(paste0("BROWSER_STARTED:", sys.nframe()), ${
          rQuote(browserStartedPath)
        }); browser(); writeLines("BROWSER_DONE", ${
          rQuote(browserDonePath)
        }) })`,
        { timeoutMs: 60_000 },
      );
      await arf.waitForFile(browserStartedPath);
      const browserStartedMarker = await Deno.readTextFile(browserStartedPath);
      const browserStartFrameDepth = Number(
        browserStartedMarker.replace(/^BROWSER_STARTED:/, "").trim(),
      );
      assert(
        Number.isSafeInteger(browserStartFrameDepth) &&
          browserStartFrameDepth > 0,
        `The BROWSER_STARTED marker did not prove a function frame: ${
          JSON.stringify(browserStartedMarker)
        }.`,
      );
      const browserStartedAt = performance.now();
      const browserRowsId = "interactive-browser-rows";
      const browserEvaluationOutcome = browserEvaluation.result.then(
        (result) => ({ state: "success" as const, result }),
        (error: unknown) => ({ state: "error" as const, error }),
      );
      const earlyBrowserOutcome = await settleWithin(
        browserEvaluationOutcome,
        3_000,
      );

      let heldRowsId = browserRowsId;
      let heldRowOffset = 1;
      let heldDonePath = browserDonePath;
      let heldCompletionMarkerObserved = browserCompletionMarkerObserved;
      let heldEvaluation = browserEvaluation;
      let heldStartedAt = browserStartedAt;
      let browserConsoleFrameDepth: number | null = null;
      let heldKind: "browser" | "sleep-frame";

      if (earlyBrowserOutcome.settled) {
        assert(
          earlyBrowserOutcome.value.state === "success" &&
            earlyBrowserOutcome.value.result.error === null,
          `The browser evaluation ended before continuation without success: ${
            JSON.stringify(earlyBrowserOutcome.value)
          }.`,
        );
        await arf.waitForFile(browserDonePath, 2_000);
        const browserDone = await fileExists(
          browserDonePath,
          "BROWSER_DONE",
        );
        const eofLog = await waitForNewLogMessage(
          arf,
          browserLogBefore,
          "no callback set, returning 0",
          2_000,
        );
        // The arf log line is auxiliary: it is reported but not required,
        // because arf 0.7.0 ends the nested read without it on every platform.
        const browserEofEvidence = {
          browserStartedMarker,
          browserStartFrameDepth,
          browserDone,
          browserEvaluationError: earlyBrowserOutcome.value.result.error,
          eofLogWasNew: eofLog.found,
        };
        assert(
          isConfirmedBrowserEof(browserEofEvidence),
          `The browser evaluation returned before console continuation, but the arf EOF evidence was incomplete: ${
            JSON.stringify({
              ...browserEofEvidence,
              browserLog: eofLog.contents,
            })
          }.`,
        );
        // TODO: arf headless does not register a ReadConsole callback, so
        // browser input returns EOF (confirmed on Windows in v0.6.0 through
        // v0.7.0-alpha.1, and on every platform since v0.7.0-beta.2). Restore browser()-held verification
        // once arf fixes this.
        heldKind = "sleep-frame";
        const sleepHoldMarkers = await markerPath();
        markerDirs.push(sleepHoldMarkers.directory);
        const sleepHoldStartedPath = `${sleepHoldMarkers.directory}/started`;
        heldDonePath = `${sleepHoldMarkers.directory}/done`;
        fallbackSleepReleasePath = `${sleepHoldMarkers.directory}/release`;
        const sleepHoldController = new AbortController();
        heldCompletionMarkerObserved = observeMarker(
          arf,
          heldDonePath,
          70_000,
          sleepHoldController.signal,
        );
        markerObservers.push({
          controller: sleepHoldController,
          observation: heldCompletionMarkerObserved,
        });
        const sleepFrameCode = [
          `writeLines(paste0("SLEEP_FRAME_STARTED:", sys.nframe()), ${
            rQuote(sleepHoldStartedPath)
          })`,
          "deadline <- Sys.time() + 60",
          `while (!file.exists(${
            rQuote(fallbackSleepReleasePath)
          }) && Sys.time() < deadline) Sys.sleep(0.01)`,
          `if (!file.exists(${
            rQuote(fallbackSleepReleasePath)
          })) stop("The test did not release the function-scoped sleep frame.")`,
          `writeLines("SLEEP_FRAME_DONE", ${rQuote(heldDonePath)})`,
        ].join("; ");
        heldEvaluation = arf.send(
          `local({ ${sleepFrameCode} })`,
          { timeoutMs: 65_000 },
        );
        await arf.waitForFile(sleepHoldStartedPath, 5_000);
        const sleepStartedMarker = await Deno.readTextFile(
          sleepHoldStartedPath,
        );
        const sleepStartFrameDepth = Number(
          sleepStartedMarker.replace(/^SLEEP_FRAME_STARTED:/, "").trim(),
        );
        assert(
          Number.isSafeInteger(sleepStartFrameDepth) &&
            sleepStartFrameDepth > 0,
          `The SLEEP_FRAME_STARTED marker did not prove a function frame: ${
            JSON.stringify(sleepStartedMarker)
          }.`,
        );
        heldStartedAt = performance.now();
        heldRowsId = "interactive-sleep-frame-rows";
        heldRowOffset = 2;
        console.log(
          `interactive regression: arf browser EOF confirmed by a new log entry; browser hold is not treated as validated; function-scoped Sys.sleep frame depth ${sleepStartFrameDepth} is used for the transport hold`,
        );
      } else {
        assert(
          !await fileExists(browserDonePath, "BROWSER_DONE"),
          "BROWSER_DONE appeared although the browser evaluation did not finish.",
        );
        heldKind = "browser";
        const preProbe = await browserProbeSnapshot(
          arf,
          browserDonePath,
          browserEvaluationOutcome,
          browserLogBefore,
        );
        if (preProbe.done || preProbe.evaluation.settled) {
          throw new Error(
            "The browser evaluation completed before the console frame probe. Pre-probe evidence: " +
              JSON.stringify(preProbe),
          );
        }
        try {
          await arf.sendConsoleInput(
            `writeLines(as.character(sys.nframe()), ${
              rQuote(browserFrameProbePath)
            })`,
          );
          await arf.waitForFile(browserFrameProbePath, 2_000);
        } catch (error) {
          const postProbe = await browserProbeSnapshot(
            arf,
            browserDonePath,
            browserEvaluationOutcome,
            browserLogBefore,
          );
          throw new Error(
            `The browser console frame probe failed: ${String(error)}. ` +
              `Pre-probe evidence: ${JSON.stringify(preProbe)}. ` +
              `Post-probe evidence: ${JSON.stringify(postProbe)}`,
          );
        }
        browserConsoleFrameDepth = Number(
          (await Deno.readTextFile(browserFrameProbePath)).trim(),
        );
        const doneAfterFrameProbe = await fileExists(
          browserDonePath,
          "BROWSER_DONE",
        );
        assert(
          !doneAfterFrameProbe && browserConsoleFrameDepth > 0,
          `The browser() frame was not active during the console frame probe. Diagnostics: ${
            JSON.stringify({
              browserStartedMarker,
              browserStartFrameDepth,
              preProbe,
              browserConsoleFrameDepth,
              doneAfterFrameProbe,
            })
          }.`,
        );
      }

      const cycles = 50;
      const cancelWireIds: string[] = [];
      for (let index = 0; index < cycles; index++) {
        const id = `interactive-cancel-${index + 1}`;
        const sentAfter = performance.now();
        await sendSchema(id);
        let wireRequest: WireFrame;
        try {
          wireRequest = await frameLog.waitFor(
            rSchemaRequest(sentAfter),
            3_000,
            `cancel cycle ${index + 1} request on the R TCP stream`,
          );
        } catch (error) {
          const recentWire = frameLog.frames.slice(-12).map((frame) => ({
            direction: frame.direction,
            value: frame.value,
          }));
          const recentBrowser = browserMessages.messages.slice(-8).map((item) =>
            item.value
          );
          throw new Error(
            `${error}\nRecent wire frames: ${
              JSON.stringify(recentWire)
            }\nRecent browser messages: ${JSON.stringify(recentBrowser)}`,
          );
        }
        const wireId = String(wireRequest.value.id);
        cancelWireIds.push(wireId);
        await browser!.send({ type: "cancel", id, session });
        await frameLog.waitFor(
          (frame) =>
            frame.direction === "to-r" && frame.value.method === "cancel" &&
            (frame.value.params as Record<string, unknown> | undefined)?.id ===
              wireId,
          3_000,
          `cancel cycle ${index + 1} cancel frame on the R TCP stream`,
        );
      }

      if (heldKind === "browser") await delay(6_000);
      const acks = frameLog.frames
        .filter((frame) =>
          frame.direction === "from-r" && frame.value.method === "ack"
        )
        .map((frame) =>
          Number((frame.value.params as Record<string, unknown>).frames)
        );
      for (let index = 1; index < acks.length; index++) {
        assert(
          acks[index] > acks[index - 1],
          "R acknowledgement counters were not strictly increasing.",
        );
      }
      assert(
        acks.length > 0 && acks.at(-1)! > 96,
        `Expected cumulative ACK progress beyond 96 frames, got ${
          acks.at(-1) ?? 0
        }.`,
      );

      await sendRows(heldRowsId, heldRowOffset);
      await frameLog.waitFor(
        rRequest(heldRowOffset),
        5_000,
        heldKind + "-frame page request on the R TCP stream",
      );
      await delay(250);
      const doneAfterHeldRequest = await fileExists(
        heldDonePath,
        heldKind === "browser" ? "BROWSER_DONE" : "SLEEP_FRAME_DONE",
      );
      const responseWhileHeld = browserMessages.messages.find(
        (message) => response(heldRowsId)(message.value),
      );
      assert(
        !doneAfterHeldRequest && !responseWhileHeld,
        "The request was not held while R remained in the " + heldKind +
          " function frame. Diagnostics: " +
          JSON.stringify({
            done: doneAfterHeldRequest,
            response: responseWhileHeld?.value ?? null,
          }),
      );

      const heldDoneLine = heldKind === "browser"
        ? "BROWSER_DONE"
        : "SLEEP_FRAME_DONE";
      const heldDoneBeforeRelease = await fileExists(
        heldDonePath,
        heldDoneLine,
      );
      const heldResponseBeforeRelease = browserMessages.messages.find(
        (message) => response(heldRowsId)(message.value),
      );
      assert(
        !heldDoneBeforeRelease && !heldResponseBeforeRelease,
        "The " + heldKind +
          " hold ended before explicit release. Diagnostics: " +
          JSON.stringify({
            done: heldDoneBeforeRelease,
            response: heldResponseBeforeRelease?.value ?? null,
          }),
      );

      if (heldKind === "browser") {
        await arf.sendConsoleInput("c");
      } else {
        assert(
          fallbackSleepReleasePath !== undefined,
          "The fallback sleep frame has no release marker.",
        );
        await Deno.writeTextFile(fallbackSleepReleasePath, "release");
      }
      const heldResult = await heldEvaluation.wait(10_000);
      assert(
        heldResult.error === null,
        "R " + heldKind + " hold evaluation failed: " + heldResult.error,
      );
      const heldCompletionMarkerAt = await markerTime(
        heldCompletionMarkerObserved,
      );
      assert(
        await fileExists(heldDonePath, heldDoneLine),
        "The " + heldKind +
          " hold did not write its completion marker after release.",
      );
      const heldResponse = await browserMessages.waitFor(
        response(heldRowsId),
        1_000,
        "automatic response after the " + heldKind + " completion marker",
      ).catch((error: unknown) => {
        const request = frameLog.frames.find(rRequest(heldRowOffset));
        const wireId = request ? String(request.value.id) : null;
        throw new Error(
          String(error) + ". Held response diagnostics: " +
            JSON.stringify({
              heldKind,
              heldRowsId,
              heldRowOffset,
              heldDoneLine,
              request: request?.value ?? null,
              terminals: wireId === null
                ? []
                : frameLog.frames.filter(terminal(wireId)).map((frame) =>
                  frame.value
                ),
              browserMessages: browserMessages.messages.slice(-12).map((item) =>
                item.value
              ),
            }),
        );
      });
      const heldResponseDelay = heldResponse.time - heldCompletionMarkerAt;
      const heldFrameDurationMs = heldCompletionMarkerAt - heldStartedAt;
      const heldWireRequest = frameLog.frames.find(rRequest(heldRowOffset));
      const heldWireId = heldWireRequest
        ? String(heldWireRequest.value.id)
        : null;
      const heldTerminalFrames = heldWireId === null
        ? []
        : frameLog.frames.filter(terminal(heldWireId));
      assert(
        heldResponseDelay <= 1_000,
        heldKind + " hold response arrived " +
          heldResponseDelay.toFixed(0) +
          " ms after its completion marker was observed.",
      );
      assert(
        heldTerminalFrames.length === 1 &&
          "result" in heldTerminalFrames[0].value &&
          !("error" in heldTerminalFrames[0].value),
        "Expected exactly one successful R terminal for held request " +
          String(heldWireId) + ". Diagnostics: " +
          JSON.stringify(heldTerminalFrames.map((frame) => frame.value)),
      );

      for (const wireId of cancelWireIds) {
        const terminals = frameLog.frames.filter(terminal(wireId));
        assert(
          terminals.length === 1,
          `Expected exactly one R terminal response for ${wireId}, got ${terminals.length}.`,
        );
        const error = terminals[0].value.error as
          | Record<string, unknown>
          | undefined;
        assert(
          error?.code === "cancelled",
          `Expected cancelled terminal for ${wireId}, got ${
            JSON.stringify(terminals[0].value)
          }.`,
        );
      }

      const freshId = "interactive-after-cancels";
      const freshStartedAt = performance.now();
      await sendRows(freshId, 100);
      await frameLog.waitFor(
        rRequest(100),
        5_000,
        "post-cancellation page request on the R TCP stream",
      );
      const freshResponse = await browserMessages.waitFor(
        response(freshId),
        1_000,
        "fresh request after fifty cancellation cycles",
      );
      const freshDelay = freshResponse.time - freshStartedAt;
      assert(
        freshDelay <= 1_000,
        `Fresh request arrived ${freshDelay.toFixed(0)} ms after submission.`,
      );
      assert(
        proxyErrors.length === 0,
        `TCP proxy failed: ${proxyErrors.join("; ")}`,
      );

      console.log(
        "interactive regression: " + heldKind + " hold response in " +
          heldResponseDelay.toFixed(0) +
          " ms after completion marker; browser() entry frame depth " +
          browserStartFrameDepth +
          (browserConsoleFrameDepth === null
            ? ""
            : ", console probe depth " + browserConsoleFrameDepth) +
          "; held frame lasted " + heldFrameDurationMs.toFixed(0) +
          " ms; " + cycles + "/" + cycles +
          " R cancellation terminals exactly once; ACK reached " +
          acks.at(-1) + " frames; fresh response in " +
          freshDelay.toFixed(0) + " ms",
      );
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        ...(fallbackSleepReleasePath === undefined
          ? []
          : [() => Deno.writeTextFile(fallbackSleepReleasePath!, "release")]),
        async () => {
          for (const observer of markerObservers) observer.controller.abort();
          await Promise.all(
            markerObservers.map((observer) => observer.observation),
          );
        },
        () => browser?.close(),
        () => arf?.close(),
        () => {
          for (const connection of proxyConnections) {
            closeQuietly(connection);
          }
        },
        () => proxy?.close(),
        async () => {
          if (!proxyTask) return;
          await proxyTask.catch((error: unknown) => {
            if (!(error instanceof Deno.errors.BadResource)) throw error;
          });
        },
        () => server?.close(),
        ...markerDirs.map((directory) => () => removeCacheDirectory(directory)),
        () => removeCacheDirectory(cacheRoot),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

Deno.test("ArfSession marker observer cancellation closes its watcher", async () => {
  const directory = await Deno.makeTempDir({ prefix: "jdv-marker-cancel-" });
  const controller = new AbortController();
  const waiting = new ArfSession().waitForFile(
    `${directory}/never-created`,
    60_000,
    controller.signal,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    controller.abort();
    const result = await Promise.race([
      waiting,
      delay(1_000).then(() => new Error("Marker wait did not cancel.")),
    ]);
    assert(
      result instanceof DOMException && result.name === "AbortError",
      `Expected marker cancellation, got ${String(result)}.`,
    );
  } finally {
    controller.abort();
    await removeCacheDirectory(directory);
  }
});

Deno.test("ArfSession preserves R errors and captures marker diagnostics", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "jdv-marker-diagnostic-",
  });
  const session = new ArfSession();
  try {
    const env = Deno.env.toObject();
    env.RUST_LOG ??= "arf_libr::sys=debug";
    await session.start({ env });
    const code = 'stop("marker-diagnostic-sentinel")';
    const evaluation = session.send(code, { timeoutMs: 5_000 });
    const evaluationResult = await evaluation.wait(8_000);
    assert(
      evaluationResult.error?.includes("marker-diagnostic-sentinel"),
      `Expected the original R evaluation error, got ${
        JSON.stringify(evaluationResult)
      }.`,
    );

    const markerError = await session.waitForFile(
      `${directory}/never-created`,
      100,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      markerError instanceof Error,
      "Expected the missing marker to fail.",
    );
    assert(
      markerError.message.includes("stop(") &&
        markerError.message.includes("marker-diagnostic-sentinel"),
      `Marker diagnostics lost the completed evaluation: ${markerError.message}`,
    );
    assert(
      markerError.message.includes("arfLogTail") &&
        markerError.message.includes("target") &&
        markerError.message.includes("realParent"),
      `Marker diagnostics omitted filesystem or R log evidence: ${markerError.message}`,
    );
  } finally {
    await session.close();
    await removeCacheDirectory(directory);
  }
});

Deno.test("RawWebSocket answers ping frames and keeps reading text messages", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  let serverConnection: Deno.Conn | undefined;
  let client: RawWebSocket | undefined;
  const serverTask = (async () => {
    serverConnection = await listener.accept();
    const reader = new SocketFrameReader(serverConnection);
    const request = await reader.readHeaders();
    const key = request.match(/\r\nSec-WebSocket-Key:\s*(.+)\r\n/i)?.[1];
    assert(
      key !== undefined,
      "The WebSocket client omitted its handshake key.",
    );
    const digest = await crypto.subtle.digest(
      "SHA-1",
      encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
    );
    const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
    await writeAll(
      serverConnection,
      encoder.encode(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      ),
    );
    await writeAll(
      serverConnection,
      new Uint8Array([0x89, 0x03, 0x6a, 0x64, 0x76]),
    );
    const pong = await reader.readFrame();
    assert(
      pong.opcode === 0xa && decoder.decode(pong.payload) === "jdv",
      `Expected a pong carrying the ping payload, got opcode ${pong.opcode}.`,
    );
    const message = encoder.encode(JSON.stringify({ type: "probe-ok" }));
    const split = Math.floor(message.length / 2);
    await writeAll(
      serverConnection,
      concat(new Uint8Array([0x01, split]), message.subarray(0, split)),
    );
    await writeAll(
      serverConnection,
      concat(
        new Uint8Array([0x80, message.length - split]),
        message.subarray(split),
      ),
    );
  })();

  try {
    client = await RawWebSocket.connect(
      `http://127.0.0.1:${address.port}/`,
    );
    const message = await client.read();
    assert(
      message.type === "probe-ok",
      `Expected the post-ping text frame, got ${JSON.stringify(message)}.`,
    );
    await serverTask;
  } finally {
    client?.close();
    listener.close();
    serverConnection?.close();
    await serverTask.catch(() => undefined);
  }
});

Deno.test("arf browser EOF requires the full observed evidence", () => {
  const evidence: BrowserEofEvidence = {
    browserStartedMarker: "BROWSER_STARTED:2",
    browserStartFrameDepth: 2,
    browserDone: true,
    browserEvaluationError: null,
    eofLogWasNew: true,
  };
  assert(
    isConfirmedBrowserEof(evidence),
    "The complete browser EOF evidence was rejected.",
  );
  assert(
    !isConfirmedBrowserEof({ ...evidence, browserDone: false }),
    "The browser EOF fixture accepted a missing completion marker.",
  );
  assert(
    !isConfirmedBrowserEof({ ...evidence, browserStartFrameDepth: 0 }),
    "The browser EOF fixture accepted a missing function frame.",
  );
  assert(
    !isConfirmedBrowserEof({
      ...evidence,
      browserEvaluationError: "R evaluation failed",
    }),
    "The browser EOF fixture accepted a failed R evaluation.",
  );
  assert(
    isConfirmedBrowserEof({ ...evidence, eofLogWasNew: false }),
    "The browser EOF fixture required the optional arf log entry.",
  );
  assert(
    isConfirmedBrowserEof(evidence),
    "The browser EOF fixture rejected evidence that includes the log entry.",
  );
});

async function forward(
  source: Deno.Conn,
  destination: Deno.Conn,
  direction: WireFrame["direction"],
  log: FrameLog,
): Promise<void> {
  const reader = source.readable.getReader();
  const writer = destination.writable.getWriter();
  let pending = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      await writer.write(next.value);
      pending += decoder.decode(next.value, { stream: true });
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length) {
          try {
            const value = JSON.parse(line);
            if (value && typeof value === "object") log.add(direction, value);
          } catch {
            throw new Error(
              `Invalid JSONL frame through the test proxy: ${
                line.slice(0, 120)
              }`,
            );
          }
        }
      }
    }
  } finally {
    try {
      await writer.close();
    } catch {
      // The opposite forwarding direction may have closed the socket.
    }
    try {
      await reader.cancel();
    } catch {
      // Socket teardown is idempotent.
    }
  }
}

async function writeAll(
  connection: Deno.Conn,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await connection.write(bytes.subarray(offset));
  }
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function closeQuietly(connection: Deno.Conn): void {
  try {
    connection.close();
  } catch {
    // Socket cleanup is idempotent.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type MarkerObservation = { time: number } | { error: unknown };

interface BrowserEofEvidence {
  browserStartedMarker: string;
  browserStartFrameDepth: number;
  browserDone: boolean;
  browserEvaluationError: string | null;
  // Auxiliary: arf may or may not log the EOF, depending on version and
  // platform, so it never decides the outcome.
  eofLogWasNew: boolean;
}

function isConfirmedBrowserEof(evidence: BrowserEofEvidence): boolean {
  return evidence.browserStartedMarker.startsWith("BROWSER_STARTED:") &&
    Number.isSafeInteger(evidence.browserStartFrameDepth) &&
    evidence.browserStartFrameDepth > 0 && evidence.browserDone &&
    evidence.browserEvaluationError === null;
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function browserProbeSnapshot(
  session: ArfSession,
  donePath: string,
  evaluation: Promise<
    | { state: "success"; result: ArfEvalResult }
    | { state: "error"; error: unknown }
  >,
  baselineLog: string,
): Promise<{
  done: boolean;
  evaluation:
    | { settled: false }
    | { settled: true; state: "success"; error: string | null }
    | { settled: true; state: "error"; error: string };
  eofLogEntriesSinceStart: number;
  logTail: string;
}> {
  const [done, evaluationState, log] = await Promise.all([
    fileExists(donePath, "BROWSER_DONE"),
    settleWithin(evaluation, 0),
    session.readLog(),
  ]);
  let summarizedEvaluation:
    | { settled: false }
    | { settled: true; state: "success"; error: string | null }
    | { settled: true; state: "error"; error: string };
  if (!evaluationState.settled) {
    summarizedEvaluation = { settled: false };
  } else if (evaluationState.value.state === "success") {
    summarizedEvaluation = {
      settled: true,
      state: "success",
      error: evaluationState.value.result.error,
    };
  } else {
    summarizedEvaluation = {
      settled: true,
      state: "error",
      error: String(evaluationState.value.error),
    };
  }
  const eofMessage = "no callback set, returning 0";
  return {
    done,
    evaluation: summarizedEvaluation,
    eofLogEntriesSinceStart: Math.max(
      0,
      countOccurrences(log, eofMessage) -
        countOccurrences(baselineLog, eofMessage),
    ),
    logTail: log.slice(-1_200),
  };
}

async function waitForNewLogMessage(
  session: ArfSession,
  baseline: string,
  message: string,
  timeoutMs: number,
): Promise<{ found: boolean; contents: string }> {
  const baselineCount = countOccurrences(baseline, message);
  const deadline = performance.now() + timeoutMs;
  let contents = baseline;
  while (performance.now() < deadline) {
    contents = await session.readLog();
    if (countOccurrences(contents, message) > baselineCount) {
      return { found: true, contents };
    }
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  }
  contents = await session.readLog();
  return {
    found: countOccurrences(contents, message) > baselineCount,
    contents,
  };
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const found = text.indexOf(needle, offset);
    if (found < 0) return count;
    count++;
    offset = found + needle.length;
  }
}

function observeMarker(
  session: ArfSession,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<MarkerObservation> {
  return session.waitForFile(path, timeoutMs, signal).then(
    () => ({ time: performance.now() }),
    (error: unknown) => ({ error }),
  );
}

async function markerTime(
  observation: Promise<MarkerObservation>,
): Promise<number> {
  const result = await observation;
  if ("error" in result) throw result.error;
  return result.time;
}

async function markerPath(): Promise<{ directory: string; path: string }> {
  const directory = await Deno.makeTempDir({ prefix: "jdv-interactive-" });
  return { directory, path: `${directory}/marker` };
}

function rQuote(value: string): string {
  return `"${
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
      .replaceAll("\n", "\\n").replaceAll("\r", "\\r")
  }"`;
}

async function fileExists(path: string, line?: string): Promise<boolean> {
  try {
    const contents = await Deno.readTextFile(path);
    return line === undefined || contents.split(/\r?\n/).includes(line);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
