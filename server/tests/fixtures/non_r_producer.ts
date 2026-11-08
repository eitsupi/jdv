/** R-free producer fixture for host compatibility and browser tests. */

type Json = Record<string, unknown>;

const limits = {
  max_unacked_frames: 16,
  max_unacked_bytes: 512 * 1024,
  queue_messages: 16,
  queue_bytes: 1024 * 1024,
  max_request_bytes: 1024,
  max_message_bytes: 1024 * 1024,
};

const arrowBundle = new URL(
  "../../web/vendor/arrow-21.2.0.min.js",
  import.meta.url,
);
let arrowPromise:
  | Promise<Record<string, (...args: never[]) => unknown>>
  | undefined;

async function arrow(): Promise<Record<string, (...args: never[]) => unknown>> {
  if (!arrowPromise) {
    arrowPromise = (async () => {
      const source = await Deno.readTextFile(arrowBundle);
      const wrapped = source.replace("}(this,", "}(globalThis,");
      new Function(wrapped)();
      return (globalThis as typeof globalThis & {
        Arrow: Record<string, (...args: never[]) => unknown>;
      }).Arrow;
    })();
  }
  return await arrowPromise;
}

export interface FixtureOptions {
  // Declares hello capabilities. `resources: true` also enables the fixture's
  // Resource Tree handling, and `resource_changes: true` its handling of
  // `resources/subscribe`.
  capabilities?: Json;
}

// A node of the fixture Resource Tree.
interface FixtureNode {
  id: string;
  label: string;
  kind: string;
  summary?: string;
  has_children: boolean;
  viewable: boolean;
  hidden?: boolean;
  unavailable?: string;
}

export const FIXTURE_TABLE_COUNT = 250;

/** Children of the fixture Resource Tree, keyed by parent node id. */
function fixtureChildren(node: string | null): FixtureNode[] | undefined {
  if (node === null) {
    return [
      container("c:main", "main", "catalog", true),
      { ...container("c:temp", "temp", "catalog", false), hidden: true },
      {
        id: "c:locked",
        label: "locked",
        kind: "container",
        has_children: false,
        viewable: false,
        unavailable: "permission_denied",
      },
    ];
  }
  if (node === "c:main") {
    return [
      container("s:main.public", "public", "container", true),
      container("s:main.empty", "empty", "container", false),
    ];
  }
  if (node === "c:temp" || node === "s:main.empty") return [];
  if (node === "s:main.public") {
    return Array.from({ length: FIXTURE_TABLE_COUNT }, (_, index) => {
      const name = `table_${String(index).padStart(3, "0")}`;
      const base: FixtureNode = {
        id: `t:public.${name}`,
        label: name,
        kind: "table",
        summary: "table, 1 column",
        has_children: false,
        viewable: true,
      };
      if (index === 7) return { ...base, hidden: true };
      if (index === 8) {
        return { ...base, viewable: false, unavailable: "stale" };
      }
      return base;
    });
  }
  return undefined;
}

function container(
  id: string,
  label: string,
  kind: string,
  hasChildren: boolean,
): FixtureNode {
  return {
    id,
    label,
    kind,
    has_children: hasChildren,
    viewable: false,
  };
}

function fixtureNodeExists(
  id: string,
  extraRoot: FixtureNode[] = [],
): FixtureNode | undefined {
  if (id === "c:locked") {
    return fixtureChildren(null)!.find((node) => node.id === id);
  }
  const extra = extraRoot.find((node) => node.id === id);
  if (extra) return extra;
  for (
    const parent of [
      null,
      "c:main",
      "s:main.public",
    ]
  ) {
    const found = fixtureChildren(parent)!.find((node) => node.id === id);
    if (found) return found;
  }
  return undefined;
}

export class NonRProducerHarness {
  readonly url: string;
  readonly producer: FixtureProducer;
  readonly #server: { close(): Promise<void> };
  readonly #cacheDir: string;
  readonly #socketPath: string;

  private constructor(
    server: { url: string; socketPath: string; close(): Promise<void> },
    producer: FixtureProducer,
    cacheDir: string,
    socketPath: string,
  ) {
    this.url = server.url;
    this.#server = server;
    this.producer = producer;
    this.#cacheDir = cacheDir;
    this.#socketPath = socketPath;
  }

  static async start(
    options: FixtureOptions = {},
  ): Promise<NonRProducerHarness> {
    const { startServer } = await import("../../main.ts");
    const cacheDir = await Deno.makeTempDir({ prefix: "jdv-nonr-unit-" });
    const server = await startServer({ mode: "tcp", httpPort: 0, cacheDir });
    const address = new URL(server.socketPath);
    const connection = await Deno.connect({
      hostname: address.hostname,
      port: Number(address.port),
    });
    const producer = new FixtureProducer(connection, options);
    const harness = new NonRProducerHarness(
      server,
      producer,
      cacheDir,
      server.socketPath,
    );
    try {
      await producer.connect();
      return harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.producer.close();
    await this.#server.close();
    await Deno.remove(this.#cacheDir, { recursive: true }).catch(() =>
      undefined
    );
  }

  async duplicateHello(): Promise<Json> {
    return await this.#helloResponse(this.producer.session, undefined);
  }

  /** Sends a hello with the given capabilities value and returns the reply. */
  async rejectedHello(capabilities: unknown): Promise<Json> {
    return await this.#helloResponse(
      `fixture.python:caps-${crypto.randomUUID()}`,
      capabilities,
    );
  }

  async #helloResponse(session: string, capabilities: unknown): Promise<Json> {
    const address = new URL(this.#socketPath);
    const connection = await Deno.connect({
      hostname: address.hostname,
      port: Number(address.port),
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(`${
      JSON.stringify({
        method: "hello",
        params: {
          protocol: 1,
          session,
          producer: { name: "compat-duplicate", version: "1.0.0" },
          ...(capabilities === undefined ? {} : { capabilities }),
          limits,
        },
      })
    }\n`);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += await connection.write(bytes.subarray(offset));
      }
      let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      for (;;) {
        const chunk = new Uint8Array(4096);
        const count = await connection.read(chunk);
        if (count === null) {
          throw new Error("Hello socket closed without a response.");
        }
        buffer = append(buffer, chunk.subarray(0, count));
        const newline = buffer.indexOf(10);
        if (newline >= 0) {
          return JSON.parse(
            decoder.decode(buffer.subarray(0, newline)),
          ) as Json;
        }
      }
    } finally {
      connection.close();
    }
  }
}

export class FixtureProducer {
  readonly session = "fixture.python:compat-1";
  readonly #connection: Deno.Conn;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #reader: Promise<void>;
  #writeTail = Promise.resolve();
  #frameCount = 0;
  #nextId = 1;
  #closed = false;
  #holdNext = false;
  #nextResourceView = 1;
  readonly #options: FixtureOptions;
  /** Resource requests received so far, in arrival order. */
  readonly resourceRequests: { id: string; method: string; params: Json }[] =
    [];
  /**
   * Replaces the built-in Resource Tree reply. Return true when the request was
   * handled; the hook may call `respond` or `respondBinary` itself.
   */
  onResource:
    | ((
      request: { id: string; method: string; params: Json },
    ) => boolean | Promise<boolean>)
    | undefined;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  readonly #extraRoot: FixtureNode[] = [];

  /** Whether the fixture currently treats the session as subscribed. */
  subscribed = false;

  /** The `enabled` values of the `resources/subscribe` requests, in order. */
  readonly subscribeRequests: boolean[] = [];

  /**
   * Sends `resources/changed` while subscribed. With `force`, it is sent even
   * when unsubscribed, and `params` replaces the default empty object, so tests
   * can send what a faulty producer would. Returns whether it was sent.
   */
  signalResourcesChanged(
    options: { force?: boolean; params?: unknown } = {},
  ): boolean {
    if (!this.subscribed && !options.force) return false;
    const frame: Json = { method: "resources/changed" };
    if (!("params" in options)) frame.params = {};
    else if (options.params !== undefined) frame.params = options.params;
    void this.#send(frame);
    return true;
  }

  /** Descriptor of the most recent view opened by `resources/open`. */
  lastResourceDescriptor: Json | undefined;

  /** Announces a newer generation of a view with another reason. */
  reannounce(descriptor: Json, generation: number, reason: string): void {
    this.#notify("view/open", { ...descriptor, generation, reason });
  }

  /** Adds a viewable table to the root listing, as if it appeared later. */
  addRootTable(label: string): void {
    this.#extraRoot.push({
      id: `t:extra.${label}`,
      label,
      kind: "table",
      has_children: false,
      viewable: true,
    });
  }

  constructor(connection: Deno.Conn, options: FixtureOptions = {}) {
    this.#connection = connection;
    this.#options = options;
    this.#reader = this.#readLoop();
  }

  async connect(): Promise<void> {
    await this.#send({
      method: "hello",
      params: {
        protocol: 1,
        session: this.session,
        producer: { name: "compat-fixture", version: "1.0.0" },
        ...(this.#options.capabilities
          ? { capabilities: this.#options.capabilities }
          : {}),
        limits,
      },
    });
    // The producer acknowledges host-to-producer frames, not its own hello.
  }

  holdNext(): void {
    this.#holdNext = true;
  }

  async openSequential(
    generation = 1,
    view = "fixture-seq",
  ): Promise<Json> {
    const data = await arrow();
    const pages = [
      ipcBytes(data, [1, 2]),
      ipcBytes(data, [3]),
      ipcBytes(data, []),
    ];
    const descriptor = {
      view,
      generation,
      kind: "grid",
      access: "sequential",
      encoding: "arrow-ipc",
      title: "Sequential fixture",
      reason: "register",
      nrow: null,
      ncol: 1,
      max_page_rows: 2,
      columns: [{
        index: 0,
        position: 0,
        ipc_index: 0,
        name: "value",
        type: "integer",
        sortable: false,
        filterable: false,
        drillable: false,
        unsupported: null,
      }],
      capabilities: {
        seek: false,
        sort: false,
        filter: false,
        known_total: false,
        next: true,
        children: false,
      },
    };
    this.#notify("view/open", descriptor);
    this.#setView(view, async (method, params, id) => {
      if (method === "view/schema") {
        await this.#reply(id, {
          view: params.view,
          generation: params.generation,
          nrow: null,
          ncol: 1,
          columns: descriptor.columns,
        });
      } else if (method === "stream/next") {
        if (this.#holdNext) {
          this.#holdNext = false;
          return;
        }
        const page = pages.shift() ?? pages[pages.length - 1];
        const first = page.first;
        const rows = page.rows;
        await this.#sendBinary({
          id,
          result: {
            view,
            generation,
            first_row: first,
            rows_fetched: rows,
            rows_seen: first + rows,
            done: page.done,
            transfer: {
              encoding: "arrow-ipc",
              byte_length: page.bytes.byteLength,
            },
          },
          warnings: [],
        }, page.bytes);
      } else if (method === "view/close") {
        await this.#reply(id, {
          view,
          generation,
          closed: true,
        });
      } else {
        await this.#reply(id, undefined, {
          code: "unsupported",
          message: "Unsupported fixture request.",
        });
      }
    });
    return descriptor;
  }

  openSnapshot(): Json {
    return this.#openJson("snapshot", "fixture-snapshot", "Snapshot fixture", [
      10,
      20,
      30,
    ]);
  }

  openRandom(): Json {
    return this.#openJson("random", "fixture-random", "Random fixture", [
      10,
      20,
      30,
    ]);
  }

  /** Sends a response frame, for tests that script resource replies. */
  async respond(id: string, result?: Json, error?: Json): Promise<void> {
    await this.#reply(id, result, error);
  }

  /** Sends a response followed by an Arrow-style opaque binary body. */
  async respondBinary(id: string, result: Json, body: Uint8Array) {
    await this.#sendBinary({ id, result, warnings: [] }, body);
  }

  async #handleResource(
    method: string,
    params: Json,
    id: string,
  ): Promise<void> {
    const request = { id, method, params };
    this.resourceRequests.push(request);
    if (this.onResource && await this.onResource(request)) return;
    if (method === "resources/subscribe") {
      if (typeof params.enabled !== "boolean") {
        await this.#reply(id, undefined, {
          code: "invalid_request",
          message: "enabled must be a Boolean.",
        });
        return;
      }
      this.subscribeRequests.push(params.enabled);
      this.subscribed = params.enabled;
      await this.#reply(id, { enabled: params.enabled });
      return;
    }
    if (method === "resources/children") {
      const node = params.node === undefined ? null : params.node;
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? 200);
      const base = node === null || typeof node === "string"
        ? fixtureChildren(node)
        : undefined;
      const all = base && node === null ? [...base, ...this.#extraRoot] : base;
      if (!all) {
        await this.#reply(id, undefined, {
          code: "invalid_request",
          message: "Unknown node id.",
        });
        return;
      }
      const children = all.slice(offset, offset + limit);
      const end = offset + children.length;
      await this.#reply(id, {
        node,
        offset,
        children,
        total_children: all.length,
        next_offset: children.length > 0 && end < all.length ? end : null,
      });
      return;
    }
    if (method === "resources/open") {
      const node = typeof params.node === "string"
        ? fixtureNodeExists(params.node, this.#extraRoot)
        : undefined;
      if (!node) {
        await this.#reply(id, undefined, {
          code: "invalid_request",
          message: "Unknown node id.",
        });
        return;
      }
      if (!node.viewable) {
        await this.#reply(id, undefined, {
          code: "unavailable",
          message: "The node cannot be opened.",
        });
        return;
      }
      const view = `fixture-res-${this.#nextResourceView++}`;
      // The view/open notification precedes the response.
      const descriptor = this.#openJson(
        "random",
        view,
        node.label,
        [10, 20, 30],
        "resource",
      );
      this.lastResourceDescriptor = descriptor;
      await this.#reply(id, descriptor);
      return;
    }
    await this.#reply(id, undefined, {
      code: "method_not_found",
      message: "Unknown fixture method.",
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
    void this.#reader.catch(() => undefined);
  }

  #openJson(
    access: "snapshot" | "random",
    view: string,
    title: string,
    values: number[],
    reason = "register",
  ): Json {
    const descriptor = {
      view,
      generation: 1,
      kind: "grid",
      access,
      encoding: "jdv-json",
      title,
      reason,
      collation: "C",
      nrow: values.length,
      ncol: 1,
      columns: [{
        position: 0,
        name: "value",
        type: "integer",
        sortable: false,
        filterable: false,
      }],
      capabilities: {
        seek: true,
        sort: false,
        filter: false,
        known_total: true,
        next: false,
        children: false,
        refresh: false,
        track: false,
      },
      ...(access === "snapshot"
        ? {
          data: {
            source_row: values.map((_, index) => index),
            row_labels: null,
            columns: [{
              values,
              display: values.map(String),
              na_rows: [],
            }],
          },
        }
        : {}),
    };
    this.#notify("view/open", descriptor);
    this.#setView(view, async (method, params, id) => {
      if (method === "grid/rows") {
        if (access === "snapshot") {
          await this.#reply(id, undefined, {
            code: "unsupported",
            message: "Snapshot views do not support grid/rows.",
          });
          return;
        }
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? values.length);
        const selected = values.slice(offset, offset + limit);
        await this.#reply(id, {
          view,
          generation: Number(params.generation ?? 1),
          total: values.length,
          total_unfiltered: values.length,
          offset,
          limit: selected.length,
          data: {
            source_row: selected.map((_, index) => offset + index),
            row_labels: null,
            columns: [{
              schema: descriptor.columns[0],
              data: {
                display: selected.map(String),
                na_rows: [],
              },
              errors: [],
            }],
          },
        });
      } else if (method === "view/schema") {
        await this.#reply(id, {
          view,
          generation: Number(params.generation ?? 1),
          nrow: values.length,
          ncol: 1,
          columns: descriptor.columns,
        });
      } else if (method === "view/close") {
        await this.#reply(id, {
          view,
          generation: Number(params.generation ?? 1),
          closed: true,
        });
      } else {
        await this.#reply(id, undefined, {
          code: "unsupported",
          message: "Unsupported fixture request.",
        });
      }
    });
    return descriptor;
  }

  #handlers = new Map<
    string,
    (method: string, params: Json, id: string) => void | Promise<void>
  >();

  #setView(
    view: string,
    handler: (method: string, params: Json, id: string) => void | Promise<void>,
  ): void {
    this.#handlers.set(view, handler);
  }

  async #readLoop(): Promise<void> {
    while (!this.#closed) {
      const chunk = new Uint8Array(64 * 1024);
      const count = await this.#connection.read(chunk);
      if (count === null) return;
      this.#buffer = append(this.#buffer, chunk.subarray(0, count));
      for (;;) {
        const newline = this.#buffer.indexOf(10);
        if (newline < 0) break;
        const bytes = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const frame = JSON.parse(this.#decoder.decode(bytes)) as Json;
        this.#frameCount++;
        if (frame.method === "ack") continue;
        if (typeof frame.id === "string" && frame.method === undefined) {
          await this.#acknowledge();
          continue;
        }
        const method = String(frame.method ?? "");
        const params = isRecord(frame.params) ? frame.params : {};
        if (method === "wake" || method === "cancel") {
          await this.#acknowledge();
          continue;
        }
        if (
          (method === "resources/children" || method === "resources/open" ||
            (method === "resources/subscribe" &&
              this.#options.capabilities?.resource_changes)) &&
          typeof frame.id === "string" && this.#options.capabilities?.resources
        ) {
          await this.#handleResource(method, params, frame.id);
          await this.#acknowledge();
          continue;
        }
        const view = String(params.view ?? "");
        const handler = this.#handlers.get(view);
        if (typeof frame.id === "string" && handler) {
          await handler(method, params, frame.id);
        }
        await this.#acknowledge();
      }
    }
  }

  async #reply(id: string, result?: Json, error?: Json): Promise<void> {
    await this.#send({ id, ...(error ? { error } : { result }), warnings: [] });
  }

  async #acknowledge(): Promise<void> {
    await this.#send({ method: "ack", params: { frames: this.#frameCount } });
  }

  async #sendBinary(header: Json, body: Uint8Array): Promise<void> {
    await this.#write(
      append(this.#encoder.encode(`${JSON.stringify(header)}\n`), body),
    );
  }

  async #send(value: Json): Promise<void> {
    await this.#write(
      this.#encoder.encode(`${JSON.stringify(value)}\n`),
    );
  }

  #write(bytes: Uint8Array): Promise<void> {
    const next = this.#writeTail.then(async () => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        offset += await this.#connection.write(bytes.subarray(offset));
      }
    });
    this.#writeTail = next.catch(() => undefined);
    return next;
  }

  #notify(method: string, params: Json): void {
    void this.#send({ method, params });
  }
}

function ipcBytes(
  arrowApi: Record<string, (...args: never[]) => unknown>,
  values: number[],
): { bytes: Uint8Array; first: number; rows: number; done: boolean } {
  const table = arrowApi.tableFromArrays(
    { value: Int32Array.from(values) } as never,
  );
  const bytes = arrowApi.tableToIPC(table as never) as Uint8Array;
  const first = values.length === 0 ? 3 : values[0] === 1 ? 0 : 2;
  return { bytes, first, rows: values.length, done: values.length === 0 };
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const value = new Uint8Array(left.byteLength + right.byteLength);
  value.set(left);
  value.set(right, left.byteLength);
  return value;
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
