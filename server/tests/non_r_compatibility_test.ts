import { assert, assertEquals } from "./assert.ts";
import { NonRProducerHarness } from "./fixtures/non_r_producer.ts";

type Frame = Record<string, unknown>;

Deno.test("R-free producer interoperates with the host over WebSocket", async () => {
  const harness = await NonRProducerHarness.start();
  const socket = await RawWebSocket.connect(harness.url);
  const queue: Array<Frame | ArrayBuffer> = [];
  const waiters: Array<() => void> = [];
  socket.onmessage = (event) => {
    queue.push(event.data as Frame | ArrayBuffer);
    for (const wake of waiters.splice(0)) wake();
  };
  try {
    await nextFrame((frame) => frame.type === "welcome");

    const duplicateHello = await harness.duplicateHello();
    assertEquals((duplicateHello.error as Frame).code, "in_use");

    const sequential = await harness.producer.openSequential();
    const opened = await nextFrame((frame) =>
      frame.type === "view/open" && isRecord(frame.message) &&
      isRecord(frame.message.params) &&
      frame.message.params.view === "fixture-seq"
    );
    assert(!(opened instanceof ArrayBuffer));
    assertEquals(
      ((opened.message as Frame).params as Frame).access,
      "sequential",
    );

    const schema = await request("view/schema", {
      view: "fixture-seq",
      generation: 1,
    });
    assertEquals(schema.type, "response");
    assertEquals((schema.result as Frame).ncol, 1);

    const first = await requestBinary("stream/next", {
      view: "fixture-seq",
      generation: 1,
      max_rows: 2,
      after_page: -1,
    });
    assertEquals((first.header.result as Frame).first_row, 0);
    assertEquals((first.header.result as Frame).rows_fetched, 2);
    assertEquals((first.header.result as Frame).done, false);

    const catalog = await request("stream/cache/info", {
      view: "fixture-seq",
      generation: 1,
    });
    assertEquals((catalog.result as Frame).last_page, 0);
    assertEquals(((catalog.result as Frame).pages as Frame[]).length, 1);

    const replay = await requestBinary("stream/cache/get", {
      view: "fixture-seq",
      generation: 1,
      page: 0,
    });
    assertEquals(
      (replay.header.result as Frame).cache_page !== undefined,
      true,
    );
    assertEquals(replay.body.byteLength, first.body.byteLength);

    const second = await requestBinary("stream/next", {
      view: "fixture-seq",
      generation: 1,
      max_rows: 2,
      after_page: 0,
    });
    assertEquals((second.header.result as Frame).first_row, 2);
    assertEquals((second.header.result as Frame).rows_fetched, 1);
    assertEquals((second.header.result as Frame).done, false);
    const eof = await requestBinary("stream/next", {
      view: "fixture-seq",
      generation: 1,
      max_rows: 2,
      after_page: 1,
    });
    assertEquals((eof.header.result as Frame).first_row, 3);
    assertEquals((eof.header.result as Frame).rows_fetched, 0);
    assertEquals((eof.header.result as Frame).done, true);

    const closedSequential = await request("view/close", {
      view: "fixture-seq",
      generation: 1,
    });
    assertEquals((closedSequential.result as Frame).closed, true);
    const closedCache = await request("stream/cache/info", {
      view: "fixture-seq",
      generation: 1,
    });
    assertEquals(closedCache.type, "error");

    const snapshot = await harness.producer.openSnapshot();
    await nextFrame((frame) =>
      frame.type === "view/open" &&
      isRecord(frame.message) && isRecord(frame.message.params) &&
      frame.message.params.view === "fixture-snapshot"
    );
    assertEquals(snapshot.encoding, "jdv-json");
    const snapshotPayload = snapshot.data as Frame;
    assertEquals(snapshotPayload.source_row, [0, 1, 2]);
    assertEquals(snapshotPayload.row_labels, null);
    assertEquals((snapshotPayload.columns as Frame[])[0].display, [
      "10",
      "20",
      "30",
    ]);
    const snapshotRows = await request("grid/rows", {
      view: "fixture-snapshot",
      generation: 1,
      offset: 1,
      limit: 1,
    });
    assertEquals(snapshotRows.type, "response");
    assertEquals((snapshotRows.error as Frame).code, "unsupported");

    const random = await harness.producer.openRandom();
    await nextFrame((frame) =>
      frame.type === "view/open" &&
      isRecord(frame.message) && isRecord(frame.message.params) &&
      frame.message.params.view === "fixture-random"
    );
    assertEquals(random.access, "random");
    const rows = await request("grid/rows", {
      view: "fixture-random",
      generation: 1,
      offset: 2,
      limit: 1,
    });
    const rowResult = rows.result as Frame;
    assertEquals(rowResult.total, 3);
    assertEquals(rowResult.total_unfiltered, 3);
    assertEquals(rowResult.offset, 2);
    assertEquals(rowResult.limit, 1);
    const rowData = rowResult.data as Frame;
    assertEquals(rowData.source_row, [2]);
    assertEquals(rowData.row_labels, null);
    const rowColumn = (rowData.columns as Frame[])[0];
    assertEquals((rowColumn.schema as Frame).name, "value");
    assertEquals((rowColumn.data as Frame).display, ["30"]);
    assertEquals((rowColumn.data as Frame).na_rows, []);

    const invalid = await request("not/a/method", {
      view: "fixture-random",
      generation: 1,
    });
    assertEquals(invalid.type, "error");

    const overBudget = await request("grid/rows", {
      view: "fixture-random",
      generation: 1,
      offset: 0,
      limit: 1,
      padding: "x".repeat(2_048),
    });
    assertEquals(overBudget.type, "error");
    assertEquals((overBudget as Frame).code, "limit_exceeded");

    const closedRandom = await request("view/close", {
      view: "fixture-random",
      generation: 1,
    });
    assertEquals((closedRandom.result as Frame).closed, true);

    await harness.producer.openSequential(2);
    await nextFrame((frame) =>
      frame.type === "view/open" &&
      isRecord(frame.message) && isRecord(frame.message.params) &&
      frame.message.params.view === "fixture-seq" &&
      frame.message.params.generation === 2
    );
    const staleCache = await request("stream/cache/info", {
      view: "fixture-seq",
      generation: 1,
    });
    assertEquals(staleCache.type, "error");
    const freshCache = await request("stream/cache/info", {
      view: "fixture-seq",
      generation: 2,
    });
    assertEquals((freshCache.result as Frame).last_page, -1);

    harness.producer.holdNext();
    const pendingId = send("request", "stream/next", {
      view: "fixture-seq",
      generation: 2,
      max_rows: 2,
      after_page: -1,
    });
    await harness.producer.openSequential(3);
    await nextFrame((frame) =>
      frame.type === "view/open" &&
      isRecord(frame.message) && isRecord(frame.message.params) &&
      frame.message.params.view === "fixture-seq" &&
      frame.message.params.generation === 3
    );
    const generationFailure = await nextFrame((frame) =>
      frame.id === pendingId
    );
    assert(!(generationFailure instanceof ArrayBuffer));
    assertEquals(generationFailure.type, "error");
    const generationCache = await request("stream/cache/info", {
      view: "fixture-seq",
      generation: 3,
    });
    assertEquals((generationCache.result as Frame).last_page, -1);

    const disconnectView = "fixture-seq-disconnect";
    await harness.producer.openSequential(1, disconnectView);
    await nextFrame((frame) =>
      frame.type === "view/open" &&
      isRecord(frame.message) && isRecord(frame.message.params) &&
      frame.message.params.view === disconnectView &&
      frame.message.params.generation === 1
    );

    harness.producer.holdNext();
    const disconnectId = send("request", "stream/next", {
      view: disconnectView,
      generation: 1,
      max_rows: 2,
      after_page: -1,
    });
    harness.producer.close();
    const disconnectFailure = await nextFrame((frame) =>
      frame.id === disconnectId
    );
    assert(!(disconnectFailure instanceof ArrayBuffer));
    assertEquals(disconnectFailure.type, "error");
    assertEquals(disconnectFailure.code, "disconnected");
    await nextFrame((frame) => frame.type === "session/closed");
    const releasedCache = await request("stream/cache/info", {
      view: disconnectView,
      generation: 1,
    });
    assertEquals(releasedCache.type, "error");

    const malformed = await RawWebSocket.connect(harness.url);
    malformed.send("{");
    await malformed.waitClosed();
    malformed.close();

    assert(sequential.view === "fixture-seq");

    // deno-lint-ignore no-inner-declarations -- These helpers close over the active test socket.
    function send(type: string, method: string, params: Frame): string {
      const id = `browser-${crypto.randomUUID()}`;
      socket.send(
        JSON.stringify({
          type,
          id,
          session: harness.producer.session,
          method,
          params,
        }),
      );
      return id;
    }

    // deno-lint-ignore no-inner-declarations -- These helpers close over the active test socket.
    async function request(method: string, params: Frame): Promise<Frame> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = send("request", method, params);
        const response = await nextFrame((frame) => frame.id === id);
        assert(!(response instanceof ArrayBuffer));
        if (response.type !== "busy") return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Host remained busy while handling ${method}.`);
    }

    // deno-lint-ignore no-inner-declarations -- These helpers close over the active test socket.
    async function requestBinary(
      method: string,
      params: Frame,
    ): Promise<{ header: Frame; body: Uint8Array }> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = send("request", method, params);
        const response = await nextFrame((frame) =>
          frame instanceof ArrayBuffer || (isRecord(frame) && frame.id === id)
        );
        if (response instanceof ArrayBuffer) {
          const body = new Uint8Array(response);
          const headerLength = new DataView(body.buffer, body.byteOffset, 4)
            .getUint32(0, true);
          return {
            header: JSON.parse(
              new TextDecoder().decode(body.subarray(4, 4 + headerLength)),
            ) as Frame,
            body: body.subarray(4 + headerLength),
          };
        }
        if (response.type !== "busy") {
          throw new Error(
            `Expected binary response for ${method}: ${
              JSON.stringify(response)
            }`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Host remained busy while handling ${method}.`);
    }

    // deno-lint-ignore no-inner-declarations -- This helper closes over the active test queue.
    async function nextFrame(
      predicate: (frame: Frame) => boolean,
    ): Promise<Frame | ArrayBuffer> {
      const deadline = Date.now() + 3_000;
      for (;;) {
        const index = queue.findIndex((value) =>
          value instanceof ArrayBuffer || predicate(value)
        );
        if (index >= 0) return queue.splice(index, 1)[0];
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for WebSocket frame; queued=${
              JSON.stringify(queue)
            }.`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            const index = waiters.indexOf(wake);
            if (index >= 0) waiters.splice(index, 1);
            reject(
              new Error(
                `Timed out waiting for WebSocket frame; queued=${
                  JSON.stringify(queue)
                }.`,
              ),
            );
          }, remaining);
          const wake = () => {
            clearTimeout(timeout);
            resolve();
          };
          waiters.push(wake);
        });
      }
    }
  } finally {
    socket.close();
    await harness.close();
  }
});

Deno.test("hello capabilities are validated over the producer socket", async () => {
  const harness = await NonRProducerHarness.start({
    capabilities: { resources: true, future_member: "ignored" },
  });
  try {
    for (const capabilities of [null, { resources: "yes" }, [true]]) {
      const reply = await harness.rejectedHello(capabilities);
      assertEquals((reply.error as Frame).code, "unsupported");
    }
  } finally {
    await harness.close();
  }
});

function isRecord(value: unknown): value is Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class RawWebSocket {
  #onmessage?: (event: { data: Frame | ArrayBuffer }) => void;
  #pending: Array<Frame | ArrayBuffer> = [];
  #connection: Deno.Conn;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #writeTail = Promise.resolve();
  #closed = false;
  #closeWaiters: Array<() => void> = [];

  private constructor(connection: Deno.Conn) {
    this.#connection = connection;
  }

  static async connect(httpUrl: string): Promise<RawWebSocket> {
    const url = new URL(httpUrl);
    const connection = await Deno.connect({
      hostname: url.hostname,
      port: Number(url.port),
    });
    const socket = new RawWebSocket(connection);
    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    await socket.#write(new TextEncoder().encode(
      `GET /ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${url.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ));
    const response = await socket.#readHeaders();
    if (!response.startsWith("HTTP/1.1 101 ")) {
      socket.close();
      throw new Error(`WebSocket upgrade failed: ${response.split("\r\n")[0]}`);
    }
    void socket.#readLoop();
    return socket;
  }

  // Frames that arrive before a handler is attached are buffered so the
  // welcome frame cannot be lost between the upgrade and the assignment.
  set onmessage(handler: (event: { data: Frame | ArrayBuffer }) => void) {
    this.#onmessage = handler;
    for (const data of this.#pending.splice(0)) handler({ data });
  }

  #deliver(data: Frame | ArrayBuffer): void {
    if (this.#onmessage) this.#onmessage({ data });
    else this.#pending.push(data);
  }

  send(value: string): void {
    void this.#sendFrame(1, new TextEncoder().encode(value));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#sendFrame(8, new Uint8Array()).finally(() =>
      this.#connection.close()
    );
  }

  async waitClosed(): Promise<void> {
    if (this.#closed) return;
    await new Promise<void>((resolve) => this.#closeWaiters.push(resolve));
  }

  async #readLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        const header = await this.#readExact(2);
        const opcode = header[0] & 0x0f;
        let length = header[1] & 0x7f;
        if (length === 126) {
          const extended = await this.#readExact(2);
          length = new DataView(extended.buffer, extended.byteOffset, 2)
            .getUint16(0);
        } else if (length === 127) {
          throw new Error("Unexpected large websocket test frame.");
        }
        const payload = await this.#readExact(length);
        if (opcode === 8) {
          this.#closed = true;
          this.#connection.close();
          for (const wake of this.#closeWaiters.splice(0)) wake();
          return;
        }
        if (opcode === 9) {
          await this.#sendFrame(10, payload);
          continue;
        }
        if (opcode === 1) {
          this.#deliver(
            JSON.parse(new TextDecoder().decode(payload)) as Frame,
          );
        } else if (opcode === 2) {
          this.#deliver(
            payload.buffer.slice(
              payload.byteOffset,
              payload.byteOffset + payload.byteLength,
            ) as ArrayBuffer,
          );
        }
      }
    } catch {
      this.close();
    }
  }

  async #readHeaders(): Promise<string> {
    const marker = new Uint8Array([13, 10, 13, 10]);
    for (;;) {
      const index = indexOf(this.#buffer, marker);
      if (index >= 0) {
        const text = new TextDecoder().decode(
          this.#buffer.subarray(0, index + 4),
        );
        this.#buffer = this.#buffer.slice(index + 4);
        return text;
      }
      const chunk = new Uint8Array(4096);
      const count = await this.#connection.read(chunk);
      if (count === null) throw new Error("WebSocket closed during upgrade.");
      this.#buffer = append(this.#buffer, chunk.subarray(0, count));
    }
  }

  async #readExact(length: number): Promise<Uint8Array> {
    while (this.#buffer.byteLength < length) {
      const chunk = new Uint8Array(64 * 1024);
      const count = await this.#connection.read(chunk);
      if (count === null) throw new Error("WebSocket connection closed.");
      this.#buffer = append(this.#buffer, chunk.subarray(0, count));
    }
    const value = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return value;
  }

  async #sendFrame(opcode: number, payload: Uint8Array): Promise<void> {
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const header = payload.length < 126
      ? new Uint8Array([0x80 | opcode, 0x80 | payload.length])
      : new Uint8Array([
        0x80 | opcode,
        0xfe,
        payload.length >>> 8,
        payload.length & 255,
      ]);
    const masked = payload.map((byte, i) => byte ^ mask[i % 4]);
    const next = this.#writeTail.then(() =>
      this.#write(append(append(header, mask), masked))
    );
    this.#writeTail = next.catch(() => undefined);
    await next;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      offset += await this.#connection.write(bytes.subarray(offset));
    }
  }
}

function append(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
