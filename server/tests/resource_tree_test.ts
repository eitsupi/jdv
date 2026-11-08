import { assert, assertEquals } from "./assert.ts";
import { type BrowserClient, Hub } from "../hub.ts";
import type { ByteConnection } from "../platform.ts";
import {
  FIXTURE_TABLE_COUNT,
  type FixtureOptions,
  FixtureProducer,
} from "./fixtures/non_r_producer.ts";

type Json = Record<string, unknown>;

class MemoryConnection implements ByteConnection {
  readonly writes: string[] = [];
  #chunks: Array<Uint8Array | null> = [];
  #readers: Array<(value: Uint8Array | null) => void> = [];
  #writeWaiters: Array<() => void> = [];
  closed = false;

  read(): Promise<Uint8Array | null> {
    if (this.#chunks.length) return Promise.resolve(this.#chunks.shift()!);
    return new Promise((resolve) => this.#readers.push(resolve));
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(new TextDecoder().decode(bytes));
    for (const wake of this.#writeWaiters.splice(0)) wake();
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#push(null);
  }

  inject(value: unknown): void {
    this.injectRaw(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  }

  injectRaw(bytes: Uint8Array): void {
    this.#push(bytes);
  }

  /** Parsed frames written to the producer so far. */
  frames(): Json[] {
    return this.writes.map((line) => JSON.parse(line) as Json);
  }

  async nextWrite(index = this.writes.length): Promise<Json> {
    while (this.writes.length <= index) {
      await new Promise<void>((resolve) => this.#writeWaiters.push(resolve));
    }
    return JSON.parse(this.writes[index]) as Json;
  }

  #push(value: Uint8Array | null): void {
    const reader = this.#readers.shift();
    if (reader) reader(value);
    else this.#chunks.push(value);
  }
}

class MemoryBrowser implements BrowserClient {
  readonly messages: Json[] = [];
  readonly binaryMessages: Uint8Array[] = [];
  #waiters: Array<() => void> = [];

  send(value: Json): void {
    this.messages.push(value);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  sendBinary(bytes: Uint8Array): void {
    this.binaryMessages.push(bytes.slice());
    for (const wake of this.#waiters.splice(0)) wake();
  }

  close(): void {}

  async nextMessage(predicate: (value: Json) => boolean): Promise<Json> {
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** The terminal frame (response, error, or cancelled) for a browser id. */
  terminal(id: string): Promise<Json> {
    return this.nextMessage((message) =>
      message.id === id &&
      (message.type === "response" || message.type === "error" ||
        message.type === "cancelled")
    );
  }
}

const LIMITS = {
  max_unacked_frames: 128,
  max_unacked_bytes: 512 * 1024,
  queue_messages: 128,
  queue_bytes: 16 * 1024 * 1024,
  max_request_bytes: 10 * 1024 * 1024,
  max_message_bytes: 10 * 1024 * 1024,
};

function helloFrame(
  session: string,
  extra: Json = { capabilities: { resources: true } },
  limits: Json = {},
): Json {
  return {
    id: "hello",
    method: "hello",
    params: {
      protocol: 1,
      session,
      producer: { name: "test", version: "1" },
      limits: { ...LIMITS, ...limits },
      ...extra,
    },
  };
}

async function setup(
  session: string,
  extra?: Json,
  limits?: Json,
): Promise<{
  hub: Hub;
  connection: MemoryConnection;
  browser: MemoryBrowser;
  request: (id: string, method: string, params?: Json) => void;
}> {
  const hub = new Hub();
  const connection = new MemoryConnection();
  const browser = new MemoryBrowser();
  hub.attach(browser);
  hub.acceptProducer(connection);
  connection.inject(helloFrame(session, extra, limits));
  await browser.nextMessage((message) => message.type === "session/open");
  const request = (id: string, method: string, params: Json = {}) =>
    hub.handleBrowser(browser, {
      type: "request",
      id,
      session,
      method,
      params,
    });
  return { hub, connection, browser, request };
}

function tableOpen(generation = 1, view = "table-1"): Json {
  return {
    method: "view/open",
    params: {
      view,
      generation,
      kind: "grid",
      access: "snapshot",
      encoding: "jdv-json",
      title: "Snapshot",
      nrow: 1,
      ncol: 1,
      columns: [{
        position: 0,
        name: "x",
        type: "integer",
        sortable: true,
        filterable: true,
      }],
      capabilities: {
        seek: true,
        sort: true,
        filter: true,
        known_total: true,
        next: false,
        children: false,
      },
      data: { columns: ["x"], rows: [[1]] },
    },
  };
}

function entry(label: string): Json {
  return {
    id: `n:${label}`,
    label,
    kind: "table",
    has_children: false,
    viewable: true,
  };
}

function page(
  node: string | null,
  offset: number,
  count: number,
  nextOffset: number | null,
  total: number | null = offset + count,
): Json {
  return {
    node,
    offset,
    children: Array.from({ length: count }, (_, i) => entry(`e${offset + i}`)),
    total_children: total,
    next_offset: nextOffset,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function methodsWritten(connection: MemoryConnection, method: string): Json[] {
  return connection.frames().filter((frame) => frame.method === method);
}

function code(message: Json): unknown {
  return message.code;
}

// --- Capability gate and hello validation ---------------------------------

Deno.test("resources requests need the capability and unknown methods stay method_not_found", async () => {
  for (
    const extra of [
      {},
      { capabilities: {} },
      { capabilities: { resources: false } },
      { capabilities: { other: true } },
    ]
  ) {
    const f = await setup("res-gate", extra);
    try {
      f.request("c", "resources/children", { node: null });
      f.request("o", "resources/open", { node: "x" });
      f.request("u", "resources/unknown", {});
      assertEquals(code(await f.browser.terminal("c")), "unsupported");
      assertEquals(code(await f.browser.terminal("o")), "unsupported");
      assertEquals(code(await f.browser.terminal("u")), "method_not_found");
      await settle();
      assertEquals(f.connection.writes.length, 0);
    } finally {
      f.hub.close();
    }
  }
});

Deno.test("hello validates capabilities and ignores unknown members", async () => {
  const bad: unknown[] = [
    null,
    1,
    "resources",
    [],
    { resources: 1 },
    { resources: "true" },
    { resources: null },
    { resources: {} },
  ];
  for (const capabilities of bad) {
    const hub = new Hub();
    const connection = new MemoryConnection();
    hub.acceptProducer(connection);
    connection.inject(helloFrame("res-bad-caps", { capabilities }));
    await new Promise<void>((resolve) => {
      const check = () => connection.closed ? resolve() : setTimeout(check, 5);
      check();
    });
    const reply = JSON.parse(connection.writes[0]) as Json;
    assertEquals((reply.error as Json).code, "unsupported");
    hub.close();
  }
  const f = await setup("res-unknown-caps", {
    capabilities: { resources: true, future: "text", nested: { a: 1 } },
  });
  try {
    f.request("c", "resources/children", { node: null });
    const sent = await f.connection.nextWrite(0);
    assertEquals(sent.method, "resources/children");
    f.connection.inject({
      id: sent.id,
      result: page(null, 0, 1, null),
      warnings: [],
    });
    assertEquals((await f.browser.terminal("c")).type, "response");
  } finally {
    f.hub.close();
  }
});

Deno.test("a capabilities hello keeps ordinary view requests working", async () => {
  const f = await setup("res-views");
  try {
    f.connection.inject(tableOpen());
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("rows", "grid/rows", { view: "table-1", generation: 1 });
    const sent = await f.connection.nextWrite(0);
    assertEquals(sent.method, "grid/rows");
    f.connection.inject({ id: sent.id, result: { rows: [] }, warnings: [] });
    assertEquals((await f.browser.terminal("rows")).type, "response");
    // A view request still needs a registered view and generation.
    f.request("gone", "grid/rows", { view: "nope", generation: 1 });
    assertEquals(code(await f.browser.terminal("gone")), "view_not_found");
  } finally {
    f.hub.close();
  }
});

// --- Parameter validation -------------------------------------------------

Deno.test("resources/children and resources/open validate parameters", async () => {
  const f = await setup("res-params");
  try {
    const wide = "あ".repeat(5_462); // 16,386 UTF-8 bytes
    const invalid: Array<[string, Json]> = [
      ["resources/children", { node: "" }],
      ["resources/children", { node: 5 }],
      ["resources/children", { node: wide }],
      ["resources/children", { node: "x".repeat(16_385) }],
      ["resources/children", { offset: -1 }],
      ["resources/children", { offset: 1.5 }],
      ["resources/children", { offset: 2 ** 53 }],
      ["resources/children", { offset: "0" }],
      ["resources/children", { offset: null }],
      ["resources/children", { limit: 0 }],
      ["resources/children", { limit: 501 }],
      ["resources/children", { limit: 1.5 }],
      ["resources/children", { limit: "10" }],
      ["resources/children", { limit: null }],
      ["resources/open", {}],
      ["resources/open", { node: null }],
      ["resources/open", { node: "" }],
      ["resources/open", { node: 7 }],
      ["resources/open", { node: wide }],
    ];
    for (const [index, [method, params]] of invalid.entries()) {
      f.request(`bad-${index}`, method, params);
      assertEquals(
        code(await f.browser.terminal(`bad-${index}`)),
        "invalid_request",
      );
    }
    await settle();
    assertEquals(f.connection.writes.length, 0);

    // Boundaries are accepted: a root request with defaults, the largest page,
    // and an id of exactly 16,384 bytes.
    f.request("ok-1", "resources/children", {});
    f.request("ok-2", "resources/children", {
      node: "x".repeat(16_384),
      offset: 0,
      limit: 500,
    });
    f.request("ok-3", "resources/open", { node: "あ".repeat(5_461) + "a" });
    await f.connection.nextWrite(2);
    const frames = methodsWritten(f.connection, "resources/children");
    assertEquals(frames.length, 2);
    assertEquals(
      Object.hasOwn(frames[0].params as Json, "view"),
      false,
    );
  } finally {
    f.hub.close();
  }
});

// --- Delivery -------------------------------------------------------------

Deno.test("resources/children works with no views and is not tied to a view", async () => {
  const f = await setup("res-noview");
  try {
    f.request("root", "resources/children", { node: null, limit: 2 });
    const sent = await f.connection.nextWrite(0);
    assertEquals(sent.method, "resources/children");
    assertEquals(sent.encoding, "json");
    assertEquals(typeof sent.deadline, "number");
    f.connection.inject({
      id: sent.id,
      result: page(null, 0, 2, 2, 5),
      warnings: [],
    });
    const response = await f.browser.terminal("root");
    assertEquals(response.type, "response");
    assertEquals(response.session, "res-noview");
    assertEquals((response.result as Json).next_offset, 2);
    // The next page advances by next_offset and may end the listing.
    f.request("more", "resources/children", {
      node: null,
      offset: 2,
      limit: 2,
    });
    const second = await f.connection.nextWrite(1);
    f.connection.inject({
      id: second.id,
      result: page(null, 2, 1, null, 3),
      warnings: [],
    });
    assertEquals((await f.browser.terminal("more")).type, "response");
    // An error from the producer is delivered as the producer's response.
    f.request("err", "resources/children", { node: "gone" });
    const third = await f.connection.nextWrite(2);
    f.connection.inject({
      id: third.id,
      error: { code: "invalid_request", message: "Unknown node." },
      warnings: [],
    });
    const error = await f.browser.terminal("err");
    assertEquals((error.error as Json).code, "invalid_request");
  } finally {
    f.hub.close();
  }
});

Deno.test("invalid resources/children results are rejected and release the slot", async () => {
  const f = await setup("res-shape");
  try {
    const cases: Array<[Json | ((id: string) => Json), Json]> = [
      [page("other", 0, 1, null), { node: null, limit: 5 }],
      [page(null, 3, 1, null), { node: null, limit: 5 }],
      [page(null, 0, 3, null), { node: null, limit: 2 }],
      [page(null, 0, 2, 3), { node: null, limit: 5 }],
      [page(null, 0, 2, 1), { node: null, limit: 5 }],
      [page(null, 0, 0, 0), { node: null, limit: 5 }],
      [{ ...page(null, 0, 1, null), children: {} }, { node: null }],
      [{ ...page(null, 0, 1, null), total_children: -1 }, { node: null }],
      [{ ...page(null, 0, 1, null), total_children: 1.5 }, { node: null }],
      [{ ...page(null, 0, 1, null), total_children: undefined }, {}],
      [{ ...page(null, 0, 1, null), next_offset: undefined }, {}],
      [{ ...page(null, 0, 1, null), node: undefined }, {}],
      [{ ...page(null, 0, 1, null), offset: undefined }, {}],
    ];
    let index = 0;
    for (const [result, params] of cases) {
      const id = `shape-${index}`;
      f.request(id, "resources/children", params);
      const sent = await f.connection.nextWrite(index);
      f.connection.inject({ id: sent.id, result, warnings: [] });
      const message = await f.browser.terminal(id);
      assertEquals([index, message.type, code(message)], [
        index,
        "error",
        "invalid_request",
      ]);
      index++;
    }
    // An empty page that is the end, and a short page that is not, are valid.
    f.request("end", "resources/children", { node: "n", offset: 9 });
    const end = await f.connection.nextWrite(index++);
    f.connection.inject({
      id: end.id,
      result: page("n", 9, 0, null, 3),
      warnings: [],
    });
    assertEquals((await f.browser.terminal("end")).type, "response");
    f.request("short", "resources/children", { limit: 10 });
    const short = await f.connection.nextWrite(index++);
    f.connection.inject({
      id: short.id,
      result: page(null, 0, 1, 1, null),
      warnings: [],
    });
    assertEquals((await f.browser.terminal("short")).type, "response");
  } finally {
    f.hub.close();
  }
});

Deno.test("resource responses with a binary transfer are rejected", async () => {
  const f = await setup("res-binary");
  try {
    f.request("bin", "resources/children", { node: null });
    const sent = await f.connection.nextWrite(0);
    const body = new Uint8Array([1, 2, 3]);
    const header = new TextEncoder().encode(`${
      JSON.stringify({
        id: sent.id,
        result: {
          ...page(null, 0, 1, null),
          // The transport only frames a body when the descriptor names a view.
          view: "v",
          generation: 1,
          transfer: { encoding: "arrow-ipc", byte_length: body.byteLength },
        },
        warnings: [],
      })
    }\n`);
    const frame = new Uint8Array(header.byteLength + body.byteLength);
    frame.set(header);
    frame.set(body, header.byteLength);
    f.connection.injectRaw(frame);
    const message = await f.browser.terminal("bin");
    assertEquals(code(message), "invalid_request");
    assertEquals(f.browser.binaryMessages.length, 0);
    // The stream stays in sync and the slot is free for the next request.
    f.request("next", "resources/children", { node: null });
    const next = await f.connection.nextWrite(1);
    f.connection.inject({
      id: next.id,
      result: page(null, 0, 1, null),
      warnings: [],
    });
    assertEquals((await f.browser.terminal("next")).type, "response");
  } finally {
    f.hub.close();
  }
});

Deno.test("resources/open registers the view from view/open and never from the response", async () => {
  const f = await setup("res-open");
  try {
    f.request("open-1", "resources/open", { node: "t:one" });
    const sent = await f.connection.nextWrite(0);
    assertEquals(sent.method, "resources/open");
    assertEquals((sent.params as Json).node, "t:one");
    const descriptor = (tableOpen(1, "opened-1").params) as Json;
    f.connection.inject({
      method: "view/open",
      params: { ...descriptor, reason: "resource" },
    });
    f.connection.inject({ id: sent.id, result: descriptor, warnings: [] });
    const opened = await f.browser.nextMessage((message) =>
      message.type === "view/open"
    );
    assertEquals(
      ((opened.message as Json).params as Json).reason,
      "resource",
    );
    const response = await f.browser.terminal("open-1");
    assertEquals(response.type, "response");
    // The view/open notification arrived before the response.
    assert(
      f.browser.messages.indexOf(opened) < f.browser.messages.indexOf(response),
    );

    // A response without a notification does not create a view.
    f.request("open-2", "resources/open", { node: "t:two" });
    const second = await f.connection.nextWrite(1);
    f.connection.inject({
      id: second.id,
      result: (tableOpen(1, "opened-2").params) as Json,
      warnings: [],
    });
    assertEquals((await f.browser.terminal("open-2")).type, "response");
    const late = new MemoryBrowser();
    f.hub.attach(late);
    const sessions = late.messages[0].sessions as Json[];
    assertEquals(
      (sessions[0].views as Json[]).map((view) => (view.params as Json).view),
      ["opened-1"],
    );

    // A non-object result is rejected.
    f.request("open-3", "resources/open", { node: "t:three" });
    const third = await f.connection.nextWrite(2);
    f.connection.inject({ id: third.id, result: [], warnings: [] });
    assertEquals(code(await f.browser.terminal("open-3")), "invalid_request");
  } finally {
    f.hub.close();
  }
});

// --- Lifecycle ------------------------------------------------------------

Deno.test("view close and new generations do not cancel resource requests", async () => {
  const f = await setup("res-lifecycle");
  try {
    f.connection.inject(tableOpen());
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("res", "resources/children", { node: "p" });
    f.request("rows", "grid/rows", { view: "table-1", generation: 1 });
    const resource = await f.connection.nextWrite(0);
    await f.connection.nextWrite(1);
    // A new generation cancels the view request only.
    f.connection.inject(tableOpen(2));
    assertEquals(code(await f.browser.terminal("rows")), "stale_generation");
    // The producer reports the view closed.
    f.connection.inject({
      method: "view/closed",
      params: { view: "table-1", generation: 2 },
    });
    await f.browser.nextMessage((message) => message.type === "view/closed");
    await settle();
    assertEquals(
      f.browser.messages.some((message) => message.id === "res"),
      false,
    );
    assertEquals(
      methodsWritten(f.connection, "cancel").map((frame) =>
        (frame.params as Json).id
      ).includes(resource.id),
      false,
    );
    f.connection.inject({
      id: resource.id,
      result: page("p", 0, 1, null),
      warnings: [],
    });
    assertEquals((await f.browser.terminal("res")).type, "response");
  } finally {
    f.hub.close();
  }
});

Deno.test("resource requests are cancelled by the browser, time out, and end with the client or session", async () => {
  const f = await setup("res-end");
  try {
    f.request("cancel-me", "resources/children", { node: "a" });
    const first = await f.connection.nextWrite(0);
    f.hub.handleBrowser(f.browser, {
      type: "cancel",
      session: "res-end",
      id: "cancel-me",
    });
    assertEquals((await f.browser.terminal("cancel-me")).type, "cancelled");
    await f.connection.nextWrite(1);
    assertEquals(
      (methodsWritten(f.connection, "cancel")[0].params as Json).id,
      first.id,
    );
    f.connection.inject({
      id: first.id,
      result: page("a", 0, 1, null),
      warnings: [],
    });
    await settle();
    assertEquals(
      f.browser.messages.filter((message) => message.id === "cancel-me")
        .length,
      1,
    );

    f.hub.handleBrowser(f.browser, {
      type: "request",
      id: "slow",
      session: "res-end",
      method: "resources/open",
      params: { node: "slow" },
      timeoutMs: 100,
    });
    const slow = await f.connection.nextWrite(2);
    assertEquals(code(await f.browser.terminal("slow")), "timeout");
    await waitFor(() =>
      methodsWritten(f.connection, "cancel").some((frame) =>
        (frame.params as Json).id === slow.id
      )
    );
    f.connection.inject({ id: slow.id, result: {}, warnings: [] });
    await settle();
    assertEquals(
      f.browser.messages.filter((message) => message.id === "slow").length,
      1,
    );

    // Detaching the client cancels its live and queued resource requests.
    const other = new MemoryBrowser();
    f.hub.attach(other);
    const before = f.connection.writes.length;
    f.hub.handleBrowser(other, {
      type: "request",
      id: "gone",
      session: "res-end",
      method: "resources/children",
      params: { node: "z" },
    });
    const live = await f.connection.nextWrite(before);
    f.hub.detach(other);
    await waitFor(() =>
      methodsWritten(f.connection, "cancel").some((frame) =>
        (frame.params as Json).id === live.id
      )
    );

    // Closing the session fails whatever is still pending.
    f.request("last", "resources/children", { node: "q" });
    await f.connection.nextWrite(f.connection.writes.length);
    f.connection.close();
    assertEquals(code(await f.browser.terminal("last")), "disconnected");
  } finally {
    f.hub.close();
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached in time.");
}

// --- Coalescing and flow control -----------------------------------------

Deno.test("resources/children coalesces only identical node and offset, and open never", async () => {
  const f = await setup("res-coalesce", undefined, {
    queue_messages: 1,
    max_unacked_frames: 64,
  });
  try {
    const children = (id: string, node: string | null, offset: number) =>
      f.request(id, "resources/children", { node, offset, limit: 10 });
    children("live", "a", 0);
    const live = await f.connection.nextWrite(0);
    f.connection.inject({ method: "ack", params: { frames: 1 } });
    children("same-1", "a", 0);
    children("same-2", "a", 0);
    children("later-page", "a", 10);
    children("other-node", "b", 0);
    f.request("open-1", "resources/open", { node: "a" });
    f.request("open-2", "resources/open", { node: "a" });
    assertEquals(
      (await f.browser.terminal("same-1")).reason,
      "superseded",
    );
    await settle();
    // Only the live request is on the wire; everything else waits for the slot.
    assertEquals(f.connection.writes.length, 1);
    const cancelled = f.browser.messages.filter((message) =>
      message.type === "cancelled"
    );
    assertEquals(cancelled.map((message) => message.id), ["same-1"]);

    // The queued requests run in order once the slot frees up.
    const order: string[] = [];
    let frames = 1;
    let currentId = live.id;
    for (let step = 0; step < 5; step++) {
      f.connection.inject({
        id: currentId,
        result: step === 0 ? page("a", 0, 1, null) : {},
        warnings: [],
      });
      const next = await f.connection.nextWrite(frames);
      f.connection.inject({ method: "ack", params: { frames: ++frames } });
      const params = next.params as Json;
      order.push(`${next.method}:${params.node}:${params.offset ?? ""}`);
      currentId = next.id;
    }
    assertEquals(order, [
      "resources/children:a:0",
      "resources/children:a:10",
      "resources/children:b:0",
      "resources/open:a:",
      "resources/open:a:",
    ]);
  } finally {
    f.hub.close();
  }
});

Deno.test("resources/children from different clients never supersede each other", async () => {
  const f = await setup("res-clients", undefined, {
    queue_messages: 1,
    max_unacked_frames: 64,
  });
  try {
    const other = new MemoryBrowser();
    f.hub.attach(other);
    f.request("live", "resources/children", { node: "a" });
    await f.connection.nextWrite(0);
    f.connection.inject({ method: "ack", params: { frames: 1 } });
    f.request("mine", "resources/children", { node: "a" });
    f.hub.handleBrowser(other, {
      type: "request",
      id: "theirs",
      session: "res-clients",
      method: "resources/children",
      params: { node: "a" },
    });
    await settle();
    assertEquals(
      [...f.browser.messages, ...other.messages].some((message) =>
        message.type === "cancelled"
      ),
      false,
    );
  } finally {
    f.hub.close();
  }
});

Deno.test("resource and view requests share the same live request slot", async () => {
  const f = await setup("res-shared", undefined, {
    queue_messages: 1,
    max_unacked_frames: 64,
  });
  try {
    f.connection.inject(tableOpen());
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("rows", "grid/rows", { view: "table-1", generation: 1 });
    const rows = await f.connection.nextWrite(0);
    f.connection.inject({ method: "ack", params: { frames: 1 } });
    f.request("res", "resources/children", { node: null });
    await settle();
    assertEquals(f.connection.writes.length, 1);
    f.connection.inject({ id: rows.id, result: {}, warnings: [] });
    const resource = await f.connection.nextWrite(1);
    assertEquals(resource.method, "resources/children");
    f.connection.inject({ method: "ack", params: { frames: 2 } });
    f.request("rows-2", "grid/rows", { view: "table-1", generation: 1 });
    await settle();
    assertEquals(f.connection.writes.length, 2);
    f.connection.inject({
      id: resource.id,
      result: page(null, 0, 1, null),
      warnings: [],
    });
    assertEquals((await f.connection.nextWrite(2)).method, "grid/rows");
  } finally {
    f.hub.close();
  }
});

Deno.test("resource requests obey the request byte limit", async () => {
  const f = await setup("res-bytes", undefined, { max_request_bytes: 400 });
  try {
    f.request("big", "resources/open", { node: "x".repeat(1_000) });
    assertEquals(code(await f.browser.terminal("big")), "limit_exceeded");
    f.request("small", "resources/open", { node: "x" });
    assertEquals((await f.connection.nextWrite(0)).method, "resources/open");
  } finally {
    f.hub.close();
  }
});

// --- Non-R fixture --------------------------------------------------------

class TcpConnection implements ByteConnection {
  readonly #connection: Deno.Conn;
  constructor(connection: Deno.Conn) {
    this.#connection = connection;
  }
  async read(): Promise<Uint8Array | null> {
    const chunk = new Uint8Array(64 * 1024);
    const count = await this.#connection.read(chunk);
    return count === null ? null : chunk.subarray(0, count);
  }
  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += await this.#connection.write(bytes.subarray(offset));
    }
  }
  close(): void {
    try {
      this.#connection.close();
    } catch {
      // Already closed.
    }
  }
}

async function fixtureHub(options: FixtureOptions = {
  capabilities: { resources: true },
}) {
  const hub = new Hub();
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  const client = await Deno.connect({
    hostname: address.hostname,
    port: address.port,
  });
  const accepted = await listener.accept();
  const browser = new MemoryBrowser();
  hub.attach(browser);
  hub.acceptProducer(new TcpConnection(accepted));
  const producer = new FixtureProducer(client, options);
  await producer.connect();
  await browser.nextMessage((message) => message.type === "session/open");
  const request = (id: string, method: string, params: Json = {}) =>
    hub.handleBrowser(browser, {
      type: "request",
      id,
      session: producer.session,
      method,
      params,
    });
  const result = async (id: string): Promise<Json> => {
    const message = await browser.terminal(id);
    assertEquals([id, message.type], [id, "response"]);
    return message.result as Json;
  };
  return {
    hub,
    browser,
    producer,
    request,
    result,
    close() {
      producer.close();
      hub.close();
      listener.close();
    },
  };
}

Deno.test("fixture lists a nested resource tree with no views and pages through it", async () => {
  const f = await fixtureHub();
  try {
    const welcome = new MemoryBrowser();
    f.hub.attach(welcome);
    assertEquals((welcome.messages[0].sessions as Json[])[0].views, []);

    f.request("root", "resources/children", { node: null });
    const root = await f.result("root");
    const nodes = root.children as Json[];
    assertEquals(nodes.map((node) => node.label), ["main", "temp", "locked"]);
    assertEquals(nodes[1].hidden, true);
    assertEquals(nodes[2].unavailable, "permission_denied");
    assertEquals(nodes[2].viewable, false);
    assertEquals(root.next_offset, null);

    f.request("main", "resources/children", { node: "c:main" });
    const main = await f.result("main");
    assertEquals((main.children as Json[]).map((node) => node.label), [
      "public",
      "empty",
    ]);

    f.request("empty", "resources/children", { node: "s:main.empty" });
    assertEquals((await f.result("empty")).children, []);

    const seen: Json[] = [];
    let offset = 0;
    let pages = 0;
    while (offset !== null) {
      const id = `page-${pages++}`;
      f.request(id, "resources/children", {
        node: "s:main.public",
        offset,
        limit: 100,
      });
      const result = await f.result(id);
      seen.push(...(result.children as Json[]));
      assertEquals(result.total_children, FIXTURE_TABLE_COUNT);
      offset = result.next_offset as number;
    }
    assertEquals(pages, 3);
    assertEquals(seen.length, FIXTURE_TABLE_COUNT);
    assertEquals(new Set(seen.map((node) => node.id)).size, seen.length);
    assertEquals(seen[7].hidden, true);
    assertEquals(seen[8].unavailable, "stale");
    assertEquals(seen[8].viewable, false);

    // Past the end returns an empty final page; unknown ids are errors.
    f.request("past", "resources/children", {
      node: "s:main.public",
      offset: 1_000,
    });
    const past = await f.result("past");
    assertEquals(past.children, []);
    assertEquals(past.next_offset, null);
    f.request("unknown", "resources/children", { node: "nope" });
    assertEquals(
      ((await f.browser.terminal("unknown")).error as Json).code,
      "invalid_request",
    );
  } finally {
    f.close();
  }
});

Deno.test("fixture opens a table as a resource view and keeps the tree after the view closes", async () => {
  const f = await fixtureHub();
  try {
    f.request("open", "resources/open", { node: "t:public.table_000" });
    const descriptor = await f.result("open");
    const view = descriptor.view as string;
    const opened = await f.browser.nextMessage((message) =>
      message.type === "view/open"
    );
    assertEquals(((opened.message as Json).params as Json).view, view);
    assertEquals(((opened.message as Json).params as Json).reason, "resource");

    f.request("rows", "grid/rows", { view, generation: 1, limit: 2 });
    const rows = await f.result("rows");
    assertEquals(rows.total, 3);

    // Opening again always creates a new view.
    f.request("open-again", "resources/open", { node: "t:public.table_000" });
    const again = await f.result("open-again");
    assert(again.view !== view);

    f.request("close", "view/close", { view, generation: 1 });
    assertEquals((await f.result("close")).closed, true);
    f.request("after", "resources/children", { node: "c:main" });
    assertEquals(((await f.result("after")).children as Json[]).length, 2);

    // Containers, unavailable nodes, and unknown ids cannot be opened.
    for (
      const [id, node, expected] of [
        ["o-container", "s:main.public", "unavailable"],
        ["o-stale", "t:public.table_008", "unavailable"],
        ["o-locked", "c:locked", "unavailable"],
        ["o-unknown", "t:nope", "invalid_request"],
      ]
    ) {
      f.request(id, "resources/open", { node });
      const message = await f.browser.terminal(id);
      assertEquals((message.error as Json).code, expected);
    }
  } finally {
    f.close();
  }
});

Deno.test("fixture without the capability rejects resources requests", async () => {
  const f = await fixtureHub({});
  try {
    f.request("c", "resources/children", { node: null });
    f.request("o", "resources/open", { node: "t:public.table_000" });
    assertEquals(code(await f.browser.terminal("c")), "unsupported");
    assertEquals(code(await f.browser.terminal("o")), "unsupported");
    assertEquals(f.producer.resourceRequests.length, 0);
    // View operations are unchanged.
    f.producer.openRandom();
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("rows", "grid/rows", {
      view: "fixture-random",
      generation: 1,
      limit: 1,
    });
    assertEquals((await f.result("rows")).total, 3);
  } finally {
    f.close();
  }
});

Deno.test("fixture with unknown capability members still serves views", async () => {
  const f = await fixtureHub({
    capabilities: { resources: true, future_feature: { level: 3 } },
  });
  try {
    f.producer.openRandom();
    await f.browser.nextMessage((message) => message.type === "view/open");
    f.request("rows", "grid/rows", {
      view: "fixture-random",
      generation: 1,
      limit: 1,
    });
    assertEquals((await f.result("rows")).total, 3);
    f.request("root", "resources/children", {});
    assertEquals(((await f.result("root")).children as Json[]).length, 3);
  } finally {
    f.close();
  }
});

Deno.test("fixture resource requests survive view close and end with the session", async () => {
  const f = await fixtureHub();
  try {
    f.producer.openRandom();
    await f.browser.nextMessage((message) => message.type === "view/open");
    let release: (() => void) | undefined;
    f.producer.onResource = (request) => {
      release = () => {
        f.producer.onResource = undefined;
        void f.producer.respond(request.id, {
          node: null,
          offset: 0,
          children: [],
          total_children: 0,
          next_offset: null,
        });
      };
      return true;
    };
    f.request("held", "resources/children", {});
    await waitFor(() => release !== undefined);
    f.request("close", "view/close", { view: "fixture-random", generation: 1 });
    assertEquals((await f.result("close")).closed, true);
    await settle();
    assertEquals(
      f.browser.messages.some((message) => message.id === "held"),
      false,
    );
    release!();
    assertEquals((await f.result("held")).next_offset, null);

    // A held request fails with `disconnected` when the session ends.
    f.producer.onResource = () => true;
    f.request("dropped", "resources/children", {});
    await waitFor(() => f.producer.resourceRequests.length === 2);
    f.producer.close();
    assertEquals(code(await f.browser.terminal("dropped")), "disconnected");
  } finally {
    f.close();
  }
});
