import {
  STREAM_CACHE_INFO_LIMIT,
  type StreamCacheOptions,
  StreamPageCache,
  type StreamProgress,
} from "./stream_cache.ts";
import {
  type JsonObject,
  type ProtocolPeer,
  startProtocolPeer,
} from "./producer_listener.ts";
import {
  MAX_PRODUCER_BINARY_FRAME_BYTES,
  MAX_PRODUCER_BINARY_HEADER_BYTES,
} from "./producer_listener.ts";
import type { ByteConnection } from "./platform.ts";

export const MAX_LIVE_REQUESTS = 32;
const MAX_OUTBOUND_FRAMES = 512;
const MAX_QUEUED_CANCELS = 32;
const MAX_QUEUED_ORDINARY = MAX_OUTBOUND_FRAMES - MAX_QUEUED_CANCELS;
const WAKE_INTERVAL_MS = 50;
const BUSY_AFTER_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const FRAMES_PER_SECOND = 128;
const FRAMES_PER_BATCH = 16;
const WIRE_MAX_FRAMES = 128;
const WIRE_MAX_BYTES = 512 * 1024;
const CANCEL_RESERVE_FRAMES = 32;
const CANCEL_RESERVE_BYTES = 16 * 1024;
const MAX_RETAINED_REQUEST_BYTES = 16 * 1024 * 1024;
const BINARY_PREFIX_BYTES = 4;
const MAX_NODE_ID_BYTES = 16_384;
const encoder = new TextEncoder();

interface ProducerLimits {
  unackedFrames: number;
  unackedBytes: number;
  queueMessages: number;
  queueBytes: number;
  maxRequestBytes: number;
  maxMessageBytes: number;
}

export interface BrowserClient {
  send(value: JsonObject, cacheReply?: boolean): void;
  sendBinary(bytes: Uint8Array, cacheReply?: boolean): void;
  close(): void;
}

interface ViewRecord {
  generation: number;
  descriptor: JsonObject;
  parentView?: string;
  sequentialOwner?: BrowserClient;
}

// A request either targets one view generation or the session itself. Session
// scope requests (resources/*) name no view, so view closes and generation
// changes never cancel them.
type RequestScope =
  | { kind: "view"; view: string; generation: number }
  | { kind: "session" };

interface ChildrenQuery {
  node: string | null;
  offset: number;
  limit: number;
}

interface PendingRequest {
  id: string;
  client: BrowserClient | null;
  browserId: string;
  method: string;
  scope: RequestScope;
  // Validated resources/children parameters, used for coalescing and for
  // checking the response.
  children?: ChildrenQuery;
  deadline: number;
  state: "queued" | "live" | "cancelled" | "expired";
  localEnded: boolean;
  sequence: number | undefined;
  requestBytes: number;
  queuedBytesAccounted: boolean;
  sentBytesAccounted: boolean;
  requestFrame: OutboundFrame | null;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  busyTimer: ReturnType<typeof setTimeout> | undefined;
  cancelSent: boolean;
  maxBytes: number;
  streamMaxRows?: number;
  // Set for a request the hub sends on its own behalf (the aggregated
  // resources/subscribe). It is called once when the request ends.
  internal?: (outcome: InternalOutcome) => void;
}

type InternalOutcome =
  | { kind: "result"; result: unknown }
  // `unknown` is true when the producer may have applied the request anyway.
  | { kind: "error"; code: string; message: string; unknown?: boolean };

// One browser resources/subscribe request that waits for the producer state
// to converge. A client has at most one at a time.
interface SubscribeWaiter {
  client: BrowserClient;
  browserId: string;
  enabled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// The hub owns the subscription wishes of the browsers and drives the single
// producer-side subscription towards them. `applied` is what the hub knows the
// producer to be doing: null after a request whose outcome is unknown.
interface SubscriptionState {
  // Clients that asked to be subscribed, with their request still open or
  // already answered.
  wanted: Set<BrowserClient>;
  // The subset that received a success and gets resources/changed.
  confirmed: Set<BrowserClient>;
  applied: boolean | null;
  inflight: { enabled: boolean } | null;
  waiters: SubscribeWaiter[];
}

interface OutboundFrame {
  value: JsonObject;
  kind: "request" | "control" | "notification";
  pending?: PendingRequest;
  bytes: number;
}

interface WireCredit {
  kind: "ordinary" | "cancel";
  bytes: number;
  pendingId?: string;
}

interface ProducerSession {
  id: string;
  hello: JsonObject;
  limits: ProducerLimits;
  wake: boolean;
  resources: boolean;
  resourceChanges: boolean;
  subscription: SubscriptionState;
  peer: ProtocolPeer;
  views: Map<string, ViewRecord>;
  pending: Map<string, PendingRequest>;
  outbound: OutboundFrame[];
  frameTimes: number[];
  liveCount: number;
  unackedRequests: number;
  unackedSequences: Set<number>;
  nextSequence: number;
  acknowledgedSequence: number;
  credits: Map<number, WireCredit>;
  ordinaryFrames: number;
  cancelFrames: number;
  ordinaryBytes: number;
  cancelBytes: number;
  queuedRequestBytes: number;
  sentRequestBytes: number;
  creditPaused: boolean;
  wakeTimer: ReturnType<typeof setInterval> | undefined;
  wakeQueued: boolean;
  drainTimer: ReturnType<typeof setTimeout> | undefined;
  draining: boolean;
  closed: boolean;
}

export class Hub {
  readonly #clients = new Set<BrowserClient>();
  readonly #sessions = new Map<string, ProducerSession>();
  readonly #peers = new Set<ProtocolPeer>();
  readonly #streamCache: StreamPageCache;

  constructor(options: StreamCacheOptions = {}) {
    this.#streamCache = new StreamPageCache(options);
  }

  acceptProducer(connection: ByteConnection): void {
    let session: ProducerSession | null = null;
    let rejectedHandshake = false;
    const peer = startProtocolPeer(
      connection,
      (message, body) => {
        if (!session) {
          if (rejectedHandshake) return;
          session = this.#acceptHello(peer, message);
          if (!session) rejectedHandshake = true;
          return;
        }
        this.#handleProducerMessage(session, message, body);
      },
      (reason) => {
        this.#peers.delete(peer);
        if (session) this.#dropSession(session, reason);
      },
    );
    this.#peers.add(peer);
  }

  attach(client: BrowserClient): void {
    this.#clients.add(client);
    client.send({
      type: "welcome",
      protocol: 1,
      capabilities: { stream_cache: this.#streamCache.capability() },
      sessions: [...this.#sessions.values()].map((session) => ({
        hello: session.hello,
        views: [...session.views.values()].map((view) => view.descriptor),
      })),
    });
  }

  detach(client: BrowserClient): void {
    this.#clients.delete(client);
    for (const session of this.#sessions.values()) {
      this.#releaseSubscriber(session, client);
      for (const view of session.views.values()) {
        if (view.sequentialOwner === client) view.sequentialOwner = undefined;
      }
      for (const pending of session.pending.values()) {
        if (pending.client === client) {
          this.#cancelPending(session, pending, "client_closed");
        }
      }
    }
  }

  handleBrowser(client: BrowserClient, value: JsonObject): void {
    if (!this.#clients.has(client)) return;
    if (value.type === "cancel") {
      this.#cancelFromBrowser(client, value);
      return;
    }
    if (value.type !== "request") {
      client.send({
        type: "error",
        code: "invalid_request",
        message: "Unknown browser message type.",
      });
      return;
    }
    const browserId = value.id;
    const sessionId = value.session;
    const method = value.method;
    const params = value.params;
    if (
      typeof browserId !== "string" || browserId.length < 1 ||
      browserId.length > 128
    ) {
      client.send({
        type: "error",
        code: "invalid_request",
        message:
          "Request id must be a non-empty string of at most 128 characters.",
      });
      return;
    }
    if (
      typeof sessionId !== "string" || typeof method !== "string" ||
      !isObject(params)
    ) {
      client.send({
        type: "error",
        id: browserId,
        code: "invalid_request",
        message: "Request requires session, method, and params.",
      });
      return;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      client.send({
        type: "error",
        id: browserId,
        code: "session_not_found",
        message: "Producer session is no longer connected.",
      });
      return;
    }
    if (
      [...session.pending.values()].some((pending) =>
        pending.client === client && pending.browserId === browserId
      ) ||
      session.subscription.waiters.some((waiter) =>
        waiter.client === client && waiter.browserId === browserId
      )
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message: "A request with this client id is already active.",
      });
      return;
    }
    if (
      ![
        "grid/rows",
        "view/schema",
        "view/close",
        "view/refresh",
        "view/track",
        "object/children",
        "object/open",
        "stream/next",
        "stream/cache/info",
        "stream/cache/get",
        "resources/children",
        "resources/open",
        "resources/subscribe",
      ].includes(method)
    ) {
      client.send({
        type: "error",
        id: browserId,
        code: "method_not_found",
        message: "Unsupported request method.",
      });
      return;
    }
    if (method === "resources/subscribe") {
      this.#subscribeFromBrowser(client, browserId, session, value, params);
      return;
    }
    if (method === "resources/children" || method === "resources/open") {
      if (!session.resources) {
        client.send({
          type: "error",
          id: browserId,
          session: session.id,
          code: "unsupported",
          message: "The producer session does not support resource trees.",
        });
        return;
      }
      const children = method === "resources/children"
        ? parseChildrenQuery(params)
        : undefined;
      if (
        method === "resources/children"
          ? !children
          : !validNodeId(params.node, false)
      ) {
        client.send({
          type: "error",
          id: browserId,
          session: session.id,
          code: "invalid_request",
          message: method === "resources/children"
            ? "resources/children requires a valid node, offset, and limit."
            : "resources/open requires a node id.",
        });
        return;
      }
      this.#queueRequest(client, browserId, session, value, params, {
        scope: { kind: "session" },
        children: children ?? undefined,
      });
      return;
    }
    const view = params.view;
    const generation = params.generation;
    if (typeof view !== "string" || !Number.isSafeInteger(generation)) {
      client.send({
        type: "error",
        id: browserId,
        code: "invalid_request",
        message: "A view and safe integer generation are required.",
      });
      return;
    }
    const current = session.views.get(view);
    if (!current) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "view_not_found",
        message: "The view is no longer available.",
      });
      return;
    }
    if (current.generation !== generation) {
      client.send({
        type: "error",
        id: browserId,
        code: "stale_generation",
        message: "The view is no longer current.",
      });
      return;
    }
    if (
      method === "view/refresh" &&
      Object.keys(params).some((name) =>
        name !== "view" && name !== "generation"
      )
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message: "view/refresh accepts only view and generation.",
      });
      return;
    }
    if (
      method === "view/track" &&
      (typeof params.enabled !== "boolean" ||
        Object.keys(params).some((name) =>
          name !== "view" && name !== "generation" && name !== "enabled"
        ))
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message:
          "view/track accepts only view, generation, and a boolean enabled.",
      });
      return;
    }
    if (method === "stream/cache/info" || method === "stream/cache/get") {
      this.#readStreamCache(
        client,
        browserId,
        session,
        current,
        method,
        params,
      );
      return;
    }
    let streamMaxRows: number | undefined;
    if (method === "stream/next") {
      const descriptor = current.descriptor.params;
      if (
        !isObject(descriptor) || descriptor.access !== "sequential" ||
        descriptor.encoding !== "arrow-ipc"
      ) {
        client.send({
          type: "error",
          id: browserId,
          code: "unsupported",
          message: "This view is not sequential.",
        });
        return;
      }
      const advertisedCap = descriptor.max_page_rows;
      if (
        typeof advertisedCap !== "number" ||
        !Number.isSafeInteger(advertisedCap) || advertisedCap < 1
      ) {
        client.send({
          type: "error",
          id: browserId,
          session: session.id,
          code: "invalid_request",
          message: "The sequential view has an invalid max_page_rows limit.",
        });
        return;
      }
      const rowCap = advertisedCap;
      const rows = params.max_rows === undefined
        ? Math.min(200, rowCap)
        : params.max_rows;
      if (
        !Number.isSafeInteger(rows) || Number(rows) < 1 ||
        Number(rows) > rowCap ||
        (Object.hasOwn(params, "max_bytes") &&
          (!Number.isSafeInteger(params.max_bytes) ||
            Number(params.max_bytes) < 0)) ||
        Object.keys(params).some((name) =>
          !["view", "generation", "max_rows", "max_bytes", "after_page"]
            .includes(name)
        )
      ) {
        client.send({
          type: "error",
          id: browserId,
          code: "invalid_request",
          message: "Invalid sequential request parameters.",
        });
        return;
      }
      streamMaxRows = Number(rows);
      if (this.#streamCache.enabled && !Object.hasOwn(params, "after_page")) {
        client.send({
          type: "error",
          id: browserId,
          session: session.id,
          code: "invalid_request",
          message:
            "after_page is required when the sequential cache is enabled.",
        });
        return;
      }
      if (Object.hasOwn(params, "after_page")) {
        if (
          !Number.isSafeInteger(params.after_page) ||
          Number(params.after_page) < -1
        ) {
          client.send({
            type: "error",
            id: browserId,
            session: session.id,
            code: "invalid_request",
            message: "after_page must be a safe integer at least -1.",
          });
          return;
        }
        if (
          this.#streamCache.enabled &&
          params.after_page !== this.#streamCache.tail(current).last_page
        ) {
          client.send({
            type: "error",
            id: browserId,
            session: session.id,
            code: "cache_changed",
            message:
              "The sequential cache tail changed; refresh the cache before advancing.",
            details: this.#streamCache.tail(current),
          });
          return;
        }
      }
      if (
        (current.sequentialOwner && current.sequentialOwner !== client) ||
        [...session.pending.values()].some((pending) =>
          pending.method === "stream/next" &&
          pending.scope.kind === "view" && pending.scope.view === view &&
          pending.scope.generation === generation
        )
      ) {
        client.send({
          type: "error",
          id: browserId,
          code: "in_use",
          message:
            "The sequential view is owned by another browser or has a request in progress.",
        });
        return;
      }
    }
    if (
      (method === "object/children" || method === "object/open") &&
      !isObjectRequest(current.descriptor, method, params)
    ) {
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message: "The request is not valid for this view.",
      });
      return;
    }

    this.#queueRequest(client, browserId, session, value, params, {
      scope: { kind: "view", view, generation: Number(generation) },
      streamMaxRows,
      owner: method === "stream/next" ? current : undefined,
    });
  }

  #queueRequest(
    client: BrowserClient | null,
    browserId: string,
    session: ProducerSession,
    value: JsonObject,
    params: JsonObject,
    options: {
      scope: RequestScope;
      children?: ChildrenQuery;
      streamMaxRows?: number;
      owner?: ViewRecord;
      internal?: (outcome: InternalOutcome) => void;
    },
  ): void {
    const method = value.method as string;
    const { scope, children, streamMaxRows } = options;
    // A request the hub sends itself reports a rejection to its owner instead
    // of a browser. The report is deferred so the owner never re-enters the
    // code that is queueing.
    const reject = (frame: JsonObject) => {
      if (client) client.send(frame);
      else if (options.internal) {
        const internal = options.internal;
        queueMicrotask(() =>
          internal({
            kind: "error",
            code: String(frame.code),
            message: String(frame.message),
          })
        );
      }
    };
    const timeout = Number.isFinite(value.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Number(value.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    // Session scope responses are JSON only, so max_bytes does not apply.
    const maxBytes = scope.kind === "session"
      ? 0
      : params.max_bytes === undefined
      ? effectiveBinaryByteLimit(session)
      : params.max_bytes;
    if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 0) {
      reject({
        type: "error",
        id: browserId,
        session: session.id,
        code: "invalid_request",
        message: "params.max_bytes must be a non-negative safe integer.",
      });
      return;
    }
    const id = `jdv-${crypto.randomUUID()}`;
    const pending: PendingRequest = {
      id,
      client,
      browserId,
      method,
      scope,
      children,
      deadline: Date.now() + timeout,
      state: "queued",
      localEnded: false,
      sequence: undefined,
      requestBytes: 0,
      queuedBytesAccounted: false,
      sentBytesAccounted: false,
      requestFrame: null,
      timeoutTimer: undefined,
      busyTimer: undefined,
      cancelSent: false,
      maxBytes: Math.min(Number(maxBytes), effectiveBinaryByteLimit(session)),
      streamMaxRows,
      internal: options.internal,
    };
    pending.requestFrame = {
      kind: "request",
      pending,
      bytes: 0,
      value: {
        id,
        method,
        params: method === "stream/next" && Object.hasOwn(params, "after_page")
          ? Object.fromEntries(
            Object.entries(params).filter(([name]) => name !== "after_page"),
          )
          : params,
        encoding: "json",
        compression: "none",
        deadline: pending.deadline / 1000,
      },
    };
    pending.requestFrame.bytes =
      encoder.encode(`${JSON.stringify(pending.requestFrame.value)}\n`)
        .byteLength;
    const requestByteLimit = Math.min(
      MAX_RETAINED_REQUEST_BYTES,
      session.limits.queueBytes,
    );
    if (
      pending.requestFrame.bytes - 1 > session.limits.maxRequestBytes ||
      pending.requestFrame.bytes - 1 > requestByteLimit ||
      pending.requestFrame.bytes > this.#ordinaryByteLimit(session)
    ) {
      reject({
        type: "error",
        id: browserId,
        session: session.id,
        code: "limit_exceeded",
        message: "The request exceeds the negotiated transport frame budget.",
      });
      return;
    }
    pending.requestBytes = pending.requestFrame.bytes - 1;
    pending.queuedBytesAccounted = true;
    session.queuedRequestBytes += pending.requestBytes;
    session.pending.set(id, pending);
    this.#coalesceQueuedQuery(session, pending);
    if (
      [...session.pending.values()].filter((item) => item.queuedBytesAccounted)
          .length > MAX_QUEUED_ORDINARY ||
      session.queuedRequestBytes > MAX_RETAINED_REQUEST_BYTES
    ) {
      this.#finishPending(session, pending);
      reject({
        type: "error",
        id: browserId,
        session: session.id,
        code: "limit_exceeded",
        message: "The negotiated producer request queue is full.",
      });
      return;
    }
    if (!this.#enqueue(session, pending.requestFrame)) {
      this.#finishPending(session, pending);
      reject({
        type: "error",
        id: browserId,
        code: "busy",
        message: "The local request queue is full.",
      });
      return;
    }
    if (options.owner && client) options.owner.sequentialOwner = client;
    pending.timeoutTimer = setTimeout(
      () => this.#expire(session, pending),
      timeout,
    );
    this.#scheduleDrain(session);
  }

  #readStreamCache(
    client: BrowserClient,
    id: string,
    session: ProducerSession,
    view: ViewRecord,
    method: string,
    params: JsonObject,
  ): void {
    const fail = (code: string, message: string) =>
      client.send(
        { type: "error", id, session: session.id, code, message },
        true,
      );
    if (!this.#streamCache.enabled) {
      fail("unsupported", "The host stream cache is disabled.");
      return;
    }
    const descriptor = view.descriptor.params;
    if (
      !isObject(descriptor) || descriptor.access !== "sequential" ||
      descriptor.encoding !== "arrow-ipc"
    ) {
      fail("unsupported", "This view is not sequential.");
      return;
    }
    const allowed = method === "stream/cache/info"
      ? ["view", "generation", "after_page", "limit"]
      : ["view", "generation", "page", "max_bytes"];
    if (Object.keys(params).some((name) => !allowed.includes(name))) {
      fail("invalid_request", "Unknown stream cache parameter.");
      return;
    }
    if (method === "stream/cache/info") {
      const after = Object.hasOwn(params, "after_page")
        ? params.after_page
        : -1;
      const limit = Object.hasOwn(params, "limit") ? params.limit : 64;
      if (
        (Object.hasOwn(params, "after_page") &&
          (!Number.isSafeInteger(after) || Number(after) < 0)) ||
        !Number.isSafeInteger(limit) || Number(limit) < 1 ||
        Number(limit) > STREAM_CACHE_INFO_LIMIT
      ) {
        fail(
          "invalid_request",
          "Invalid stream cache cursor or catalog limit.",
        );
        return;
      }
      const response = {
        type: "response",
        id,
        session: session.id,
        result: {
          view: params.view,
          generation: view.generation,
          ...this.#streamCache.info(view, Number(after), Number(limit)),
        },
        warnings: [],
      };
      if (
        encoder.encode(JSON.stringify(response)).byteLength >
          MAX_PRODUCER_BINARY_HEADER_BYTES
      ) {
        fail(
          "limit_exceeded",
          "The cache catalog exceeds the JSON header limit.",
        );
        return;
      }
      client.send(response, true);
      return;
    }
    const budget = Object.hasOwn(params, "max_bytes")
      ? params.max_bytes
      : effectiveBinaryByteLimit(session);
    if (
      !Number.isSafeInteger(params.page) || Number(params.page) < 0 ||
      !Number.isSafeInteger(budget) || Number(budget) < 0
    ) {
      fail("invalid_request", "Invalid cache page index or byte budget.");
      return;
    }
    const page = this.#streamCache.get(view, Number(params.page));
    if (!page) {
      fail(
        "unavailable",
        "This stream page is not retained in the host cache.",
      );
      return;
    }
    if (
      page.body.byteLength >
        Math.min(Number(budget), effectiveBinaryByteLimit(session))
    ) {
      fail(
        "limit_exceeded",
        "The cached page exceeds the requested byte budget.",
      );
      return;
    }
    const { first_row, rows_fetched, rows_seen, done } = page.metadata;
    const frame = encodeBrowserBinary({
      type: "response",
      id,
      session: session.id,
      result: {
        view: params.view,
        generation: view.generation,
        first_row,
        rows_fetched,
        rows_seen,
        done,
        transfer: { encoding: "arrow-ipc", byte_length: page.body.byteLength },
        cache_page: page.metadata,
      },
      warnings: [],
    }, page.body);
    if (!frame) {
      fail("limit_exceeded", "The cached page exceeds the binary frame limit.");
      return;
    }
    client.sendBinary(frame, true);
  }

  close(): void {
    for (const peer of this.#peers) peer.close();
    this.#peers.clear();
    for (const session of [...this.#sessions.values()]) {
      this.#dropSession(session, "server_shutdown");
    }
    for (const client of this.#clients) client.close();
    this.#clients.clear();
  }

  #acceptHello(
    peer: ProtocolPeer,
    message: JsonObject,
  ): ProducerSession | null {
    const params = message.params;
    const limits = isObject(params) && isObject(params.limits)
      ? parseLimits(params.limits)
      : null;
    const producer = isObject(params) && isObject(params.producer)
      ? parseProducer(params.producer)
      : null;
    if (
      message.method !== "hello" || !isObject(params) ||
      params.protocol !== 1 ||
      typeof params.session !== "string" ||
      !isValidProducerSessionId(params.session) || !limits ||
      !producer ||
      (params.wake !== undefined && typeof params.wake !== "boolean") ||
      !validCapabilities(params.capabilities)
    ) {
      void peer.send({
        id: null,
        error: {
          code: "unsupported",
          message: "Protocol version 1 hello is required.",
        },
        warnings: [],
      }).catch(() => undefined).finally(() => peer.close());
      return null;
    }
    const id = params.session;
    const previous = this.#sessions.get(id);
    if (previous) {
      void peer.send({
        id: null,
        error: {
          code: "in_use",
          message: "The producer session id is already in use.",
        },
        warnings: [],
      }).catch(() => undefined).finally(() => peer.close());
      return null;
    }
    const session: ProducerSession = {
      id,
      hello: message,
      limits,
      wake: params.wake === true,
      resources: isObject(params.capabilities) &&
        params.capabilities.resources === true,
      resourceChanges: isObject(params.capabilities) &&
        params.capabilities.resource_changes === true,
      subscription: {
        wanted: new Set(),
        confirmed: new Set(),
        applied: false,
        inflight: null,
        waiters: [],
      },
      peer,
      views: new Map(),
      pending: new Map(),
      outbound: [],
      frameTimes: [],
      liveCount: 0,
      unackedRequests: 0,
      unackedSequences: new Set(),
      nextSequence: 0,
      acknowledgedSequence: 0,
      credits: new Map(),
      ordinaryFrames: 0,
      cancelFrames: 0,
      ordinaryBytes: 0,
      cancelBytes: 0,
      queuedRequestBytes: 0,
      sentRequestBytes: 0,
      creditPaused: false,
      wakeTimer: undefined,
      wakeQueued: false,
      drainTimer: undefined,
      draining: false,
      closed: false,
    };
    this.#sessions.set(id, session);
    this.#broadcast({ type: "session/open", session: id, hello: message });
    return session;
  }

  #handleProducerMessage(
    session: ProducerSession,
    message: JsonObject,
    body?: Uint8Array,
  ): void {
    if (session.closed) return;
    if (typeof message.method === "string") {
      if (message.method === "ack") {
        this.#acknowledgeFrames(session, message.params);
        return;
      }
      this.#handleNotification(session, message);
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = session.pending.get(message.id);
    if (
      !pending || pending.sequence === undefined || !isTerminalResponse(message)
    ) {
      return;
    }
    this.#releaseRequestSlot(session, pending);
    if (pending.internal) {
      const internal = pending.internal;
      pending.internal = undefined;
      const live = !pending.localEnded && pending.state === "live";
      this.#finishPending(session, pending);
      if (live) {
        const error = message.error;
        if (body !== undefined) {
          internal({
            kind: "error",
            code: "invalid_request",
            message: "The producer returned a binary body for a subscription.",
            unknown: true,
          });
        } else if (isObject(error)) {
          internal({
            kind: "error",
            code: String(error.code),
            message: typeof error.message === "string"
              ? error.message.slice(0, 1024)
              : "The producer rejected the subscription request.",
          });
        } else internal({ kind: "result", result: message.result });
      }
      this.#scheduleDrain(session);
      return;
    }
    const scope = pending.scope;
    const view = scope.kind === "view"
      ? session.views.get(scope.view)
      : undefined;
    const currentGeneration = scope.kind === "view" &&
      view?.generation === scope.generation;
    // A sent view/refresh is a generation-moving command: the producer queues the new
    // view/open before the response, so the response is expected to arrive
    // after its own generation was superseded. Cancel, timeout, close, and
    // disconnect still end it (localEnded); it never touches display state.
    // A sent view/track that resumes following may rebuild the view, so it
    // is treated the same way.
    const refreshAck = pending.method === "view/refresh" ||
      pending.method === "view/track";
    const deliver = !pending.localEnded && pending.state === "live" &&
      (scope.kind === "session" || currentGeneration || refreshAck) &&
      Date.now() < pending.deadline;
    if (
      refreshAck &&
      !(pending.method === "view/track"
        ? isTrackResponse(pending, message)
        : isRefreshResponse(pending, message))
    ) {
      if (deliver) {
        pending.client?.send({
          type: "error",
          id: pending.browserId,
          session: session.id,
          code: "invalid_request",
          message:
            "The producer returned a response that does not match the request.",
        });
      }
      this.#finishPending(session, pending);
      this.#scheduleDrain(session);
      return;
    }
    if (scope.kind === "session") {
      // Resource tree responses are JSON only and name no view.
      const invalid = body !== undefined ||
        (Object.hasOwn(message, "result") &&
          !validResourceResult(pending, message.result));
      if (invalid) {
        if (deliver) {
          pending.client?.send({
            type: "error",
            id: pending.browserId,
            session: session.id,
            code: "invalid_request",
            message: body !== undefined
              ? "The producer returned a binary body for a resource request."
              : "The producer returned a response that does not match the request.",
          });
        }
        this.#finishPending(session, pending);
        this.#scheduleDrain(session);
        return;
      }
    } else if (
      body && isObject(message.result) &&
      (message.result.view !== scope.view ||
        message.result.generation !== scope.generation)
    ) {
      if (deliver) {
        pending.client?.send({
          type: "error",
          id: pending.browserId,
          session: session.id,
          code: message.result.view !== scope.view
            ? "invalid_request"
            : "stale_generation",
          message:
            "The producer returned a binary response for a different view generation.",
        });
      }
      this.#finishPending(session, pending);
      this.#scheduleDrain(session);
      return;
    }
    let cachedPage;
    if (
      this.#streamCache.enabled && pending.method === "stream/next" &&
      currentGeneration && body && isObject(message.result)
    ) {
      const progress = validStreamProgress(
        message.result,
        pending.streamMaxRows!,
      );
      const transfer = message.result.transfer;
      const valid = progress && body.byteLength <= pending.maxBytes &&
        isObject(transfer) &&
        transfer.encoding === "arrow-ipc" &&
        transfer.byte_length === body.byteLength;
      if (valid) cachedPage = this.#streamCache.record(view!, progress, body);
      if (!valid || !cachedPage) {
        if (deliver) {
          pending.client?.send({
            type: "error",
            id: pending.browserId,
            session: session.id,
            code: body.byteLength > pending.maxBytes
              ? "limit_exceeded"
              : "invalid_request",
            message:
              "The producer returned invalid sequential page metadata, cursor, or byte length.",
          });
        }
        this.#finishPending(session, pending);
        this.#scheduleDrain(session);
        return;
      }
    }
    // A child view is registered from the producer's view/open notification, which is
    // sent before this response; the response never creates or revives a view.
    const closedCurrentView = pending.method === "view/close" &&
      currentGeneration &&
      isObject(message.result) && message.result.closed === true &&
      scope.kind === "view" && message.result.view === scope.view &&
      message.result.generation === scope.generation;
    if (deliver) {
      const response: JsonObject = {
        ...message,
        type: "response",
        session: session.id,
        id: pending.browserId,
      };
      if (cachedPage && isObject(message.result)) {
        response.result = { ...message.result, cache_page: cachedPage };
      }
      if (body) {
        if (body.byteLength > pending.maxBytes) {
          pending.client?.send({
            type: "error",
            id: pending.browserId,
            session: session.id,
            code: "limit_exceeded",
            message:
              "The producer's binary response exceeds the requested max_bytes.",
          });
        } else {
          const binaryFrame = encodeBrowserBinary(response, body);
          if (binaryFrame) pending.client?.sendBinary(binaryFrame);
          else {
            pending.client?.send({
              type: "error",
              id: pending.browserId,
              session: session.id,
              code: "limit_exceeded",
              message: "The binary response exceeds the browser frame limit.",
            });
          }
        }
      } else {
        pending.client?.send(response);
      }
    }
    this.#finishPending(session, pending);
    if (closedCurrentView && scope.kind === "view") {
      this.#closeCachedView(session, scope.view, scope.generation);
    }
    this.#scheduleDrain(session);
  }

  #registerView(
    session: ProducerSession,
    message: JsonObject,
    parentView?: string,
  ): void {
    const params = message.params;
    if (
      !isObject(params) || typeof params.view !== "string" ||
      params.view.length === 0 ||
      typeof params.generation !== "number" ||
      !Number.isSafeInteger(params.generation) || params.generation <= 0
    ) return;
    const viewId = params.view;
    const generation = Number(params.generation);
    if (parentView === undefined && params.parent !== undefined) {
      if (typeof params.parent !== "string") return;
      parentView = params.parent;
    }
    if (
      parentView !== undefined &&
      !this.#hasValidParent(session, viewId, parentView)
    ) return;
    const previous = session.views.get(viewId);
    if (previous && generation <= previous.generation) return;
    if (previous) {
      this.#streamCache.drop(previous);
      this.#closeDescendants(session, viewId);
      this.#cancelViewGeneration(session, viewId, previous.generation, true);
    }
    session.views.set(viewId, {
      generation,
      descriptor: message,
      parentView,
    });
    this.#broadcast({ type: "view/open", session: session.id, message });
  }

  #closeCachedView(
    session: ProducerSession,
    viewId: string,
    generation: number,
    message?: JsonObject,
  ): void {
    const view = session.views.get(viewId);
    if (!view || view.generation !== generation) return;
    this.#closeDescendants(session, viewId);
    this.#cancelViewGeneration(session, viewId, generation);
    this.#streamCache.drop(view);
    session.views.delete(viewId);
    this.#broadcast({
      type: "view/closed",
      session: session.id,
      message: message ?? {
        method: "view/closed",
        params: { view: viewId, generation },
      },
    });
  }

  #closeDescendants(session: ProducerSession, parentView: string): void {
    this.#closeDescendantsVisited(session, parentView, new Set([parentView]));
  }

  #closeDescendantsVisited(
    session: ProducerSession,
    parentView: string,
    visited: Set<string>,
  ): void {
    const descendants = [...session.views.entries()].filter(([, view]) =>
      view.parentView === parentView
    );
    for (const [viewId, view] of descendants) {
      if (visited.has(viewId)) continue;
      visited.add(viewId);
      this.#closeDescendantsVisited(session, viewId, visited);
      this.#cancelViewGeneration(session, viewId, view.generation);
      this.#streamCache.drop(view);
      session.views.delete(viewId);
      this.#broadcast({
        type: "view/closed",
        session: session.id,
        message: {
          method: "view/closed",
          params: {
            view: viewId,
            generation: view.generation,
            reason: "parent_closed",
          },
        },
      });
    }
  }

  #hasValidParent(
    session: ProducerSession,
    viewId: string,
    parentView: string,
  ): boolean {
    const seen = new Set<string>();
    let current: string | undefined = parentView;
    while (current !== undefined) {
      if (current === viewId || seen.has(current)) return false;
      seen.add(current);
      const parent = session.views.get(current);
      if (!parent) return false;
      current = parent.parentView;
    }
    return true;
  }

  #handleNotification(session: ProducerSession, message: JsonObject): void {
    const params = message.params;
    if (
      message.method === "view/open" && isObject(params) &&
      typeof params.view === "string" &&
      Number.isSafeInteger(params.generation)
    ) {
      this.#registerView(session, message);
      return;
    }
    if (
      message.method === "view/closed" && isObject(params) &&
      typeof params.view === "string" &&
      Number.isSafeInteger(params.generation)
    ) {
      this.#closeCachedView(
        session,
        params.view,
        Number(params.generation),
        message,
      );
      return;
    }
    if (message.method === "view/update_failed") {
      // The producer keeps the previous view when a tracked update fails. Only a report
      // for the generation the hub still holds reaches the browsers.
      if (
        !isObject(params) || typeof params.view !== "string" ||
        !Number.isSafeInteger(params.generation) ||
        typeof params.code !== "string" || typeof params.message !== "string"
      ) return;
      const view = session.views.get(params.view);
      if (!view || view.generation !== Number(params.generation)) return;
      this.#broadcast({
        type: "notification",
        session: session.id,
        message: {
          method: "view/update_failed",
          params: {
            view: params.view,
            generation: Number(params.generation),
            code: params.code.slice(0, 64),
            message: params.message.slice(0, 1024),
          },
        },
      });
      return;
    }
    if (message.method === "view/tracking") {
      this.#trackingChanged(session, params);
      return;
    }
    if (message.method === "resources/changed") {
      this.#resourcesChanged(session, params);
      return;
    }
    this.#broadcast({ type: "notification", session: session.id, message });
  }

  // The producer announces a tracking state change that comes without a new view/open.
  // The cached descriptor follows it so a browser that connects later sees the
  // current state; only a report for the held generation is passed on.
  #trackingChanged(session: ProducerSession, params: unknown): void {
    if (
      !isObject(params) || typeof params.view !== "string" ||
      !Number.isSafeInteger(params.generation)
    ) return;
    const tracking = sanitizeTracking(params.tracking);
    const view = session.views.get(params.view);
    if (!tracking || !view || view.generation !== Number(params.generation)) {
      return;
    }
    const descriptor = view.descriptor.params;
    if (isObject(descriptor)) {
      const capabilities = isObject(descriptor.capabilities)
        ? { ...descriptor.capabilities, track: tracking.state !== "lost" }
        : descriptor.capabilities;
      view.descriptor = {
        ...view.descriptor,
        params: { ...descriptor, tracking, capabilities },
      };
    }
    this.#broadcast({
      type: "notification",
      session: session.id,
      message: {
        method: "view/tracking",
        params: {
          view: params.view,
          generation: Number(params.generation),
          tracking,
        },
      },
    });
  }

  // A producer change hint reaches only the clients whose subscription was
  // confirmed. It is never stored or broadcast to everyone.
  #resourcesChanged(session: ProducerSession, params: unknown): void {
    const subscription = session.subscription;
    if (
      !session.resourceChanges || !isObject(params) ||
      subscription.applied === false || subscription.confirmed.size === 0
    ) return;
    for (const client of [...subscription.confirmed]) {
      try {
        client.send({
          type: "notification",
          session: session.id,
          message: { method: "resources/changed", params: {} },
        });
      } catch {
        this.detach(client);
      }
    }
  }

  #subscribeFromBrowser(
    client: BrowserClient,
    browserId: string,
    session: ProducerSession,
    value: JsonObject,
    params: JsonObject,
  ): void {
    const subscription = session.subscription;
    const fail = (code: string, message: string) =>
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code,
        message,
      });
    if (!session.resourceChanges) {
      fail(
        "unsupported",
        "The producer session does not support resource change notifications.",
      );
      return;
    }
    if (
      typeof params.enabled !== "boolean" ||
      Object.keys(params).some((name) => name !== "enabled")
    ) {
      fail(
        "invalid_request",
        "resources/subscribe accepts only a boolean enabled.",
      );
      return;
    }
    if (subscription.waiters.some((waiter) => waiter.client === client)) {
      fail(
        "busy",
        "A resources/subscribe request from this client is already active.",
      );
      return;
    }
    const enabled = params.enabled;
    if (enabled) subscription.wanted.add(client);
    else {
      // Leaving takes effect at once; the wait only reports the producer side.
      subscription.wanted.delete(client);
      subscription.confirmed.delete(client);
    }
    const timeout = Number.isFinite(value.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Number(value.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    const waiter: SubscribeWaiter = {
      client,
      browserId,
      enabled,
      timer: undefined,
    };
    waiter.timer = setTimeout(() => {
      if (!subscription.waiters.includes(waiter)) return;
      this.#endWaiter(session, waiter);
      client.send({
        type: "error",
        id: browserId,
        session: session.id,
        code: "timeout",
        message:
          "The producer did not complete this request before its deadline.",
      });
      this.#reconcile(session);
    }, timeout);
    subscription.waiters.push(waiter);
    this.#reconcile(session, timeout);
  }

  // Removes a waiter that ends without an answer. An enable that was never
  // confirmed is withdrawn so that it cannot keep the producer subscribed.
  #endWaiter(session: ProducerSession, waiter: SubscribeWaiter): void {
    const subscription = session.subscription;
    clearTimeout(waiter.timer);
    const index = subscription.waiters.indexOf(waiter);
    if (index >= 0) subscription.waiters.splice(index, 1);
    if (waiter.enabled && !subscription.confirmed.has(waiter.client)) {
      subscription.wanted.delete(waiter.client);
    }
  }

  // A client left: drop its wishes and waits and let the producer follow.
  #releaseSubscriber(session: ProducerSession, client: BrowserClient): void {
    const subscription = session.subscription;
    for (const waiter of [...subscription.waiters]) {
      if (waiter.client !== client) continue;
      clearTimeout(waiter.timer);
      subscription.waiters.splice(subscription.waiters.indexOf(waiter), 1);
    }
    subscription.wanted.delete(client);
    subscription.confirmed.delete(client);
    this.#reconcile(session);
  }

  // Moves the producer towards the state the subscribed clients want. Only one
  // producer request is outstanding; a change of wishes while it runs is
  // handled when it ends.
  #reconcile(session: ProducerSession, timeout = DEFAULT_TIMEOUT_MS): void {
    const subscription = session.subscription;
    if (session.closed || subscription.inflight) return;
    const desired = subscription.wanted.size > 0;
    if (subscription.applied !== desired) {
      subscription.inflight = { enabled: desired };
      this.#queueRequest(
        null,
        "",
        session,
        { method: "resources/subscribe", timeoutMs: timeout },
        { enabled: desired },
        {
          scope: { kind: "session" },
          internal: (outcome) =>
            this.#subscriptionSettled(session, desired, outcome),
        },
      );
      return;
    }
    this.#settleWaiters(session);
  }

  #subscriptionSettled(
    session: ProducerSession,
    enabled: boolean,
    outcome: InternalOutcome,
  ): void {
    const subscription = session.subscription;
    if (session.closed) return;
    subscription.inflight = null;
    let failure: { code: string; message: string } | null = null;
    if (outcome.kind === "result") {
      const result = outcome.result;
      if (isObject(result) && result.enabled === enabled) {
        subscription.applied = enabled;
      } else {
        subscription.applied = isObject(result) &&
            typeof result.enabled === "boolean"
          ? result.enabled
          : null;
        failure = {
          code: "invalid_request",
          message:
            "The producer returned a response that does not match the request.",
        };
      }
    } else {
      failure = { code: outcome.code, message: outcome.message };
      if (outcome.unknown) subscription.applied = null;
    }
    if (failure) {
      for (const waiter of [...subscription.waiters]) {
        if (waiter.enabled !== enabled) continue;
        // A client that already left is satisfied when others still want the
        // subscription, which settles it below.
        if (!waiter.enabled && subscription.wanted.size > 0) continue;
        this.#endWaiter(session, waiter);
        waiter.client.send({
          type: "error",
          id: waiter.browserId,
          session: session.id,
          ...failure,
        });
      }
    }
    // Waiters whose wish holds now are answered before any follow-up request.
    this.#settleWaiters(session);
    // A failure is not retried on its own; only a change of wishes starts
    // another producer request.
    if (!failure || (subscription.wanted.size > 0) !== enabled) {
      this.#reconcile(session);
    }
  }

  // Answers the waiters whose wish now holds. Called only while no producer
  // request is outstanding.
  #settleWaiters(session: ProducerSession): void {
    const subscription = session.subscription;
    for (const waiter of [...subscription.waiters]) {
      const done = waiter.enabled
        ? subscription.applied === true
        : subscription.applied === false || subscription.wanted.size > 0;
      if (!done) continue;
      clearTimeout(waiter.timer);
      subscription.waiters.splice(subscription.waiters.indexOf(waiter), 1);
      if (waiter.enabled) subscription.confirmed.add(waiter.client);
      waiter.client.send({
        type: "response",
        id: waiter.browserId,
        session: session.id,
        result: { enabled: waiter.enabled },
        warnings: [],
      });
    }
  }

  #cancelFromBrowser(client: BrowserClient, value: JsonObject): void {
    const session = typeof value.session === "string"
      ? this.#sessions.get(value.session)
      : undefined;
    if (!session || typeof value.id !== "string") return;
    const waiter = session.subscription.waiters.find((item) =>
      item.client === client && item.browserId === value.id
    );
    if (waiter) {
      // Only the wait ends. A subscription that was dropped stays dropped, and
      // one that was never confirmed is withdrawn.
      this.#endWaiter(session, waiter);
      client.send({
        type: "cancelled",
        id: waiter.browserId,
        session: session.id,
      });
      this.#reconcile(session);
      return;
    }
    for (const pending of session.pending.values()) {
      if (pending.client === client && pending.browserId === value.id) {
        this.#cancelPending(session, pending, "browser_cancel");
      }
    }
  }

  #cancelViewGeneration(
    session: ProducerSession,
    view: string,
    generation: number,
    keepSentRefresh = false,
  ): void {
    for (const pending of session.pending.values()) {
      if (
        pending.scope.kind === "view" && pending.scope.view === view &&
        pending.scope.generation === generation
      ) {
        // Moving to a newer generation must not cancel the refresh that
        // caused it; its response is checked when it arrives.
        if (
          keepSentRefresh &&
          (pending.method === "view/refresh" ||
            pending.method === "view/track") &&
          pending.state === "live" && !pending.localEnded
        ) continue;
        pending.client?.send({
          type: "error",
          id: pending.browserId,
          session: session.id,
          code: "stale_generation",
          message: "The view generation changed.",
        });
        this.#cancelPending(session, pending, "stale_generation");
      }
    }
  }

  #cancelPending(
    session: ProducerSession,
    pending: PendingRequest,
    reason: string,
  ): void {
    if (pending.localEnded || pending.state === "cancelled") return;
    const wasSent = pending.state === "live";
    pending.state = "cancelled";
    if (!wasSent && pending.requestFrame) {
      const index = session.outbound.indexOf(pending.requestFrame);
      if (index >= 0) session.outbound.splice(index, 1);
    } else if (wasSent) {
      this.#sendCancel(session, pending);
    }
    if (reason !== "stale_generation" && reason !== "client_closed") {
      pending.client?.send({
        type: "cancelled",
        id: pending.browserId,
        session: session.id,
      });
    }
    if (!wasSent) this.#finishPending(session, pending);
    else {
      pending.localEnded = true;
      clearTimeout(pending.timeoutTimer);
      clearTimeout(pending.busyTimer);
      pending.client = null;
      pending.browserId = "";
      pending.requestFrame = null;
    }
    this.#scheduleDrain(session);
  }

  #sendCancel(session: ProducerSession, pending: PendingRequest): void {
    if (pending.cancelSent || session.closed) return;
    const queued = this.#enqueue(session, {
      kind: "control",
      value: { method: "cancel", params: { id: pending.id } },
      bytes: 0,
    });
    pending.cancelSent = queued;
  }

  #expire(session: ProducerSession, pending: PendingRequest): void {
    if (pending.state === "cancelled") {
      pending.state = "expired";
      clearTimeout(pending.timeoutTimer);
      clearTimeout(pending.busyTimer);
      return;
    }
    const wasSent = pending.state === "live";
    if (wasSent) this.#sendCancel(session, pending);
    if (!pending.localEnded) {
      pending.client?.send({
        type: "error",
        id: pending.browserId,
        session: session.id,
        code: "timeout",
        message:
          "The producer did not complete this request before its deadline.",
      });
    }
    if (wasSent) {
      pending.state = "expired";
      pending.localEnded = true;
      clearTimeout(pending.timeoutTimer);
      clearTimeout(pending.busyTimer);
      pending.client = null;
      pending.browserId = "";
      pending.requestFrame = null;
    } else {
      if (pending.requestFrame) {
        const index = session.outbound.indexOf(pending.requestFrame);
        if (index >= 0) session.outbound.splice(index, 1);
      }
      pending.state = "expired";
      this.#finishPending(session, pending);
    }
    const internal = pending.internal;
    pending.internal = undefined;
    internal?.({
      kind: "error",
      code: "timeout",
      message:
        "The producer did not complete this request before its deadline.",
      unknown: wasSent,
    });
    this.#scheduleDrain(session);
  }

  #finishPending(session: ProducerSession, pending: PendingRequest): void {
    if (!session.pending.has(pending.id)) return;
    clearTimeout(pending.timeoutTimer);
    clearTimeout(pending.busyTimer);
    pending.localEnded = true;
    this.#releaseRequestBudget(session, pending);
    session.pending.delete(pending.id);
    if (
      ![...session.pending.values()].some((item) =>
        item.state === "live" && !item.localEnded
      )
    ) this.#stopWake(session);
  }

  #releaseRequestBudget(
    session: ProducerSession,
    pending: PendingRequest,
  ): void {
    if (pending.queuedBytesAccounted) {
      session.queuedRequestBytes = Math.max(
        0,
        session.queuedRequestBytes - pending.requestBytes,
      );
      pending.queuedBytesAccounted = false;
    }
    if (pending.sentBytesAccounted) {
      session.sentRequestBytes = Math.max(
        0,
        session.sentRequestBytes - pending.requestBytes,
      );
      pending.sentBytesAccounted = false;
      if (pending.sequence !== undefined) {
        session.unackedSequences.delete(pending.sequence);
      }
      session.unackedRequests = Math.max(0, session.unackedRequests - 1);
      session.liveCount = Math.max(0, session.liveCount - 1);
    }
  }

  #coalesceQueuedQuery(
    session: ProducerSession,
    pending: PendingRequest,
  ): void {
    if (!isCoalescibleMethod(pending.method)) return;
    for (const old of [...session.pending.values()]) {
      if (
        old !== pending && old.state === "queued" &&
        this.#sameQueryLane(old, pending)
      ) {
        old.state = "cancelled";
        old.localEnded = true;
        old.client?.send({
          type: "cancelled",
          id: old.browserId,
          session: session.id,
          reason: "superseded",
        });
        this.#finishPending(session, old);
      }
    }
    session.outbound = session.outbound.filter((frame) =>
      !frame.pending || frame.pending.state === "queued"
    );
  }

  #sameQueryLane(left: PendingRequest, right: PendingRequest): boolean {
    if (left.client !== right.client || left.method !== right.method) {
      return false;
    }
    // Session scope requests have no view; only children pages of the same
    // node and offset share a lane, so a later offset is never dropped.
    if (left.method === "resources/children") {
      return left.scope.kind === "session" && right.scope.kind === "session" &&
        left.children !== undefined && right.children !== undefined &&
        left.children.node === right.children.node &&
        left.children.offset === right.children.offset;
    }
    if (
      left.scope.kind !== "view" || right.scope.kind !== "view" ||
      left.scope.view !== right.scope.view ||
      left.scope.generation !== right.scope.generation
    ) return false;
    if (left.method === "grid/rows") return true;
    if (left.method !== "object/children") return false;
    const leftParams = left.requestFrame?.value.params;
    const rightParams = right.requestFrame?.value.params;
    return isObject(leftParams) && isObject(rightParams) &&
      JSON.stringify(leftParams.path) === JSON.stringify(rightParams.path);
  }

  #enqueue(session: ProducerSession, frame: OutboundFrame): boolean {
    if (session.outbound.length >= MAX_OUTBOUND_FRAMES) return false;
    const cancel = frame.value.method === "cancel";
    const queued = session.outbound.reduce(
      (count, item) => count + Number(item.value.method === "cancel"),
      0,
    );
    if (
      cancel
        ? queued >= MAX_QUEUED_CANCELS
        : session.outbound.length - queued >= MAX_QUEUED_ORDINARY
    ) return false;
    frame.bytes ||=
      encoder.encode(`${JSON.stringify(frame.value)}\n`).byteLength;
    session.outbound.push(frame);
    return true;
  }

  #scheduleDrain(session: ProducerSession): void {
    if (
      session.closed || session.draining || session.drainTimer !== undefined
    ) return;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = undefined;
      void this.#drain(session);
    }, 0);
  }

  async #drain(session: ProducerSession): Promise<void> {
    if (session.closed || session.draining) return;
    session.draining = true;
    let sent = 0;
    try {
      while (!session.closed && sent < FRAMES_PER_BATCH) {
        const now = performance.now();
        session.frameTimes = session.frameTimes.filter((time) =>
          now - time < 1_000
        );
        if (session.frameTimes.length >= FRAMES_PER_SECOND) {
          const delay = Math.max(1, 1_000 - (now - session.frameTimes[0]));
          session.drainTimer = setTimeout(() => {
            session.drainTimer = undefined;
            void this.#drain(session);
          }, delay);
          break;
        }
        session.outbound = session.outbound.filter((frame) =>
          !frame.pending || frame.pending.state === "queued"
        );
        const index = session.outbound.findIndex((frame) =>
          this.#frameEligible(session, frame)
        );
        if (index < 0) break;
        const frame = session.outbound[index];
        const kind = frame.value.method === "cancel" ? "cancel" : "ordinary";
        session.outbound.splice(index, 1);
        if (frame.value.method === "wake") session.wakeQueued = false;
        if (frame.pending && Date.now() >= frame.pending.deadline) {
          this.#expire(session, frame.pending);
          continue;
        }
        const sequence = ++session.nextSequence;
        this.#chargeWireCredit(
          session,
          sequence,
          kind,
          frame.bytes,
          frame.pending?.id,
        );
        if (frame.pending) {
          if (frame.pending.queuedBytesAccounted) {
            session.queuedRequestBytes = Math.max(
              0,
              session.queuedRequestBytes - frame.pending.requestBytes,
            );
            frame.pending.queuedBytesAccounted = false;
          }
          frame.pending.state = "live";
          frame.pending.sequence = sequence;
          frame.pending.sentBytesAccounted = true;
          session.sentRequestBytes += frame.pending.requestBytes;
          session.liveCount++;
          session.unackedRequests++;
          session.unackedSequences.add(sequence);
        }
        try {
          await session.peer.send(frame.value);
        } catch (error) {
          this.#dropSession(session, error);
          break;
        }
        this.#queueDeferredCancels(session);
        session.frameTimes.push(performance.now());
        sent++;
        if (
          frame.pending && frame.pending.state === "live" &&
          !frame.pending.localEnded
        ) {
          frame.pending.busyTimer = setTimeout(() => {
            if (frame.pending?.state === "live" && !frame.pending.localEnded) {
              frame.pending.client?.send({
                type: "busy",
                id: frame.pending.browserId,
              });
            }
          }, BUSY_AFTER_MS);
          this.#startWake(session);
        }
      }
    } finally {
      session.draining = false;
      if (
        session.outbound.some((frame) => this.#blockedOnCredit(session, frame))
      ) {
        this.#pauseForCredit(session);
      }
      if (
        session.outbound.some((frame) => this.#frameEligible(session, frame))
      ) this.#scheduleDrain(session);
    }
  }

  #startWake(session: ProducerSession): void {
    if (!session.wake || session.wakeTimer !== undefined) return;
    session.wakeTimer = setInterval(() => {
      if (
        session.closed ||
        ![...session.pending.values()].some((pending) =>
          pending.state === "live" && !pending.localEnded
        )
      ) {
        this.#stopWake(session);
        return;
      }
      if (
        !session.wakeQueued && session.outbound.length < MAX_OUTBOUND_FRAMES &&
        this.#hasWireCredit(session, "ordinary", 128)
      ) {
        session.wakeQueued = this.#enqueue(session, {
          kind: "control",
          value: { method: "wake" },
          bytes: 0,
        });
        this.#scheduleDrain(session);
      } else if (!session.wakeQueued && !session.creditPaused) {
        this.#pauseForCredit(session);
      }
    }, WAKE_INTERVAL_MS);
  }

  #stopWake(session: ProducerSession): void {
    if (session.wakeTimer !== undefined) clearInterval(session.wakeTimer);
    session.wakeTimer = undefined;
    session.wakeQueued = false;
    session.outbound = session.outbound.filter((frame) =>
      frame.value.method !== "wake"
    );
  }

  #dropSession(session: ProducerSession, reason: unknown): void {
    if (session.closed) return;
    session.closed = true;
    session.peer.close();
    this.#stopWake(session);
    clearTimeout(session.drainTimer);
    for (const pending of [...session.pending.values()]) {
      pending.client?.send({
        type: "error",
        id: pending.browserId,
        session: session.id,
        code: "disconnected",
        message: "The producer connection closed.",
      });
      pending.internal = undefined;
      this.#finishPending(session, pending);
    }
    const subscription = session.subscription;
    for (const waiter of subscription.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.client.send({
        type: "error",
        id: waiter.browserId,
        session: session.id,
        code: "disconnected",
        message: "The producer connection closed.",
      });
    }
    subscription.wanted.clear();
    subscription.confirmed.clear();
    subscription.inflight = null;
    for (const view of session.views.values()) this.#streamCache.drop(view);
    session.views.clear();
    this.#sessions.delete(session.id);
    this.#broadcast({
      type: "session/closed",
      session: session.id,
      reason: String(reason ?? "eof"),
    });
  }

  #broadcast(value: JsonObject): void {
    for (const client of [...this.#clients]) {
      try {
        client.send(value);
      } catch {
        this.detach(client);
      }
    }
  }

  #hasWireCredit(
    session: ProducerSession,
    kind: "ordinary" | "cancel",
    bytes: number,
  ): boolean {
    const usedFrames = session.credits.size;
    const usedBytes = session.ordinaryBytes + session.cancelBytes;
    const maxFrames = Math.min(WIRE_MAX_FRAMES, session.limits.unackedFrames);
    const maxBytes = Math.min(WIRE_MAX_BYTES, session.limits.unackedBytes);
    if (usedFrames >= maxFrames || usedBytes + bytes > maxBytes) {
      return false;
    }
    const reservedFrames = this.#cancelFrameReserve(session);
    const reservedBytes = this.#cancelByteReserve(session);
    if (kind === "cancel") {
      if (reservedFrames === 0 || reservedBytes === 0) {
        return session.ordinaryFrames < this.#ordinaryFrameLimit(session) &&
          session.ordinaryBytes + bytes <= this.#ordinaryByteLimit(session);
      }
      return session.cancelFrames < reservedFrames &&
        session.cancelBytes + bytes <= reservedBytes;
    }
    return session.ordinaryFrames < this.#ordinaryFrameLimit(session) &&
      session.ordinaryBytes + bytes <= this.#ordinaryByteLimit(session);
  }

  #chargeWireCredit(
    session: ProducerSession,
    sequence: number,
    kind: "ordinary" | "cancel",
    bytes: number,
    pendingId?: string,
  ): void {
    session.credits.set(sequence, { kind, bytes, pendingId });
    if (kind === "cancel") {
      session.cancelBytes += bytes;
      session.cancelFrames++;
    } else {
      session.ordinaryBytes += bytes;
      session.ordinaryFrames++;
    }
  }

  #acknowledgeFrames(session: ProducerSession, params: unknown): void {
    if (!isObject(params) || !Number.isSafeInteger(params.frames)) return;
    const sequence = Number(params.frames);
    if (
      sequence < 0 || sequence > session.nextSequence ||
      sequence <= session.acknowledgedSequence
    ) return;
    session.acknowledgedSequence = sequence;
    for (const [frameSequence, credit] of session.credits) {
      if (frameSequence > sequence) continue;
      session.credits.delete(frameSequence);
      if (credit.kind === "cancel") {
        session.cancelBytes -= credit.bytes;
        session.cancelFrames--;
      } else {
        session.ordinaryBytes -= credit.bytes;
        session.ordinaryFrames--;
      }
    }
    session.creditPaused = false;
    this.#scheduleDrain(session);
  }

  #releaseRequestSlot(session: ProducerSession, pending: PendingRequest): void {
    this.#releaseRequestBudget(session, pending);
  }

  #frameEligible(session: ProducerSession, frame: OutboundFrame): boolean {
    if (frame.pending && frame.pending.state !== "queued") return false;
    const pending = frame.pending;
    if (pending) {
      if (
        session.liveCount >= this.#liveRequestLimit(session) ||
        session.unackedRequests >= this.#liveRequestLimit(session)
      ) return false;
      if (
        session.sentRequestBytes + pending.requestBytes >
          Math.min(MAX_RETAINED_REQUEST_BYTES, session.limits.queueBytes)
      ) return false;
      if (
        isCoalescibleMethod(pending.method) &&
        [...session.pending.values()].some((other) =>
          other !== pending && other.client === pending.client &&
          this.#sameQueryLane(other, pending) &&
          other.state === "live" && !other.localEnded
        )
      ) return false;
    }
    const kind = frame.value.method === "cancel" ? "cancel" : "ordinary";
    return this.#hasWireCredit(session, kind, frame.bytes);
  }

  #blockedOnCredit(session: ProducerSession, frame: OutboundFrame): boolean {
    if (frame.pending && frame.pending.state !== "queued") return false;
    const pending = frame.pending;
    if (
      pending && isCoalescibleMethod(pending.method) &&
      [...session.pending.values()].some((other) =>
        other !== pending && other.client === pending.client &&
        this.#sameQueryLane(other, pending) && other.state === "live" &&
        !other.localEnded
      )
    ) return false;
    if (pending && session.liveCount >= this.#liveRequestLimit(session)) {
      return false;
    }
    if (pending && session.unackedRequests >= this.#liveRequestLimit(session)) {
      return true;
    }
    if (
      pending && session.sentRequestBytes + pending.requestBytes >
        Math.min(MAX_RETAINED_REQUEST_BYTES, session.limits.queueBytes)
    ) return false;
    const kind = frame.value.method === "cancel" ? "cancel" : "ordinary";
    return !this.#hasWireCredit(session, kind, frame.bytes);
  }

  #pauseForCredit(session: ProducerSession): void {
    if (session.creditPaused) return;
    session.creditPaused = true;
    this.#broadcast({
      type: "busy",
      session: session.id,
      reason: "wire_credit",
    });
  }

  #queueDeferredCancels(session: ProducerSession): void {
    for (const pending of session.pending.values()) {
      if (
        pending.localEnded && !pending.cancelSent &&
        pending.sequence !== undefined
      ) {
        this.#sendCancel(session, pending);
      }
    }
  }

  #liveRequestLimit(session: ProducerSession): number {
    return Math.min(MAX_LIVE_REQUESTS, session.limits.queueMessages);
  }

  #ordinaryFrameLimit(session: ProducerSession): number {
    const total = Math.min(WIRE_MAX_FRAMES, session.limits.unackedFrames);
    return total - this.#cancelFrameReserve(session);
  }

  #ordinaryByteLimit(session: ProducerSession): number {
    const total = Math.min(WIRE_MAX_BYTES, session.limits.unackedBytes);
    return total - this.#cancelByteReserve(session);
  }

  #cancelFrameReserve(session: ProducerSession): number {
    const total = Math.min(WIRE_MAX_FRAMES, session.limits.unackedFrames);
    const messages = this.#liveRequestLimit(session);
    return Math.min(CANCEL_RESERVE_FRAMES, messages, total - 1);
  }

  #cancelByteReserve(session: ProducerSession): number {
    const total = Math.min(WIRE_MAX_BYTES, session.limits.unackedBytes);
    return Math.min(CANCEL_RESERVE_BYTES, total - 1);
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCoalescibleMethod(method: string): boolean {
  return method === "grid/rows" || method === "object/children" ||
    method === "resources/children";
}

function isObjectRequest(
  descriptor: JsonObject,
  method: string,
  params: JsonObject,
): boolean {
  const viewParams = descriptor.params;
  const path = params.path;
  if (
    !isObject(viewParams) ||
    !isObject(viewParams.capabilities) ||
    viewParams.capabilities.children !== true || !Array.isArray(path) ||
    path.length > 32
  ) return false;
  if (viewParams.kind === "grid") {
    if (method !== "object/open" || path.length === 0) return false;
    const cell = path[0];
    if (
      !isObject(cell) || cell.kind !== "cell" || Object.hasOwn(cell, "type") ||
      !Number.isSafeInteger(cell.source_row) || Number(cell.source_row) < 0 ||
      !Number.isSafeInteger(cell.column) || Number(cell.column) < 0 ||
      !isTypedPath(path.slice(1))
    ) return false;
    const columns = viewParams.columns;
    const schema = Array.isArray(columns)
      ? columns.find((column) =>
        isObject(column) && column.position === cell.column
      )
      : undefined;
    return isObject(schema) && schema.drillable === true &&
      (!Number.isSafeInteger(viewParams.nrow) ||
        Number(cell.source_row) < Number(viewParams.nrow));
  }
  if (viewParams.kind !== "tree" || !isTypedPath(path)) return false;
  if (method === "object/open") {
    return Array.isArray(path) && path.length > 0;
  }
  const offset = params.offset == null ? 0 : params.offset;
  const limit = params.limit == null ? 200 : params.limit;
  return Number.isSafeInteger(offset) && Number(offset) >= 0 &&
    Number.isSafeInteger(limit) && Number(limit) >= 1 &&
    Number(limit) <= 500;
}

function isTypedPath(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every((step) => {
    if (!isObject(step)) return false;
    if (Object.hasOwn(step, "kind")) return false;
    if (step.type === "index") {
      return Number.isSafeInteger(step.index) && Number(step.index) >= 1;
    }
    if (
      step.type !== "binding" && step.type !== "slot" &&
      step.type !== "attr"
    ) return false;
    return typeof step.name === "string" &&
      Array.from(step.name).length <= 1_000;
  });
}

function parseLimits(value: JsonObject): ProducerLimits | null {
  const fields = [
    "max_unacked_frames",
    "max_unacked_bytes",
    "queue_messages",
    "queue_bytes",
    "max_request_bytes",
    "max_message_bytes",
  ] as const;
  if (
    fields.some((field) =>
      !Number.isSafeInteger(value[field]) || Number(value[field]) < 1
    )
  ) return null;
  return {
    unackedFrames: Number(value.max_unacked_frames),
    unackedBytes: Number(value.max_unacked_bytes),
    queueMessages: Number(value.queue_messages),
    queueBytes: Number(value.queue_bytes),
    maxRequestBytes: Number(value.max_request_bytes),
    maxMessageBytes: Number(value.max_message_bytes),
  };
}

function parseProducer(value: JsonObject): JsonObject | null {
  if (
    !isValidMetadataText(value.name) || !isValidMetadataText(value.version)
  ) {
    return null;
  }
  if (value.runtime !== undefined) {
    if (
      !isObject(value.runtime) ||
      !isValidMetadataText(value.runtime.name) ||
      !isValidMetadataText(value.runtime.version)
    ) return null;
  }
  return value;
}

function isValidMetadataText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = new TextEncoder().encode(value).byteLength;
  return length >= 1 && length <= 256;
}

function isValidProducerSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 &&
    !/[^A-Za-z0-9._:-]/.test(value);
}

function effectiveBinaryByteLimit(session: ProducerSession): number {
  return Math.max(
    0,
    Math.min(session.limits.maxMessageBytes, MAX_PRODUCER_BINARY_FRAME_BYTES) -
      MAX_PRODUCER_BINARY_HEADER_BYTES - BINARY_PREFIX_BYTES,
  );
}

function encodeBrowserBinary(
  envelope: JsonObject,
  body: Uint8Array,
): Uint8Array | null {
  const header = encoder.encode(JSON.stringify(envelope));
  if (
    header.byteLength > MAX_PRODUCER_BINARY_HEADER_BYTES ||
    header.byteLength + BINARY_PREFIX_BYTES + body.byteLength >
      MAX_PRODUCER_BINARY_FRAME_BYTES
  ) return null;
  const result = new Uint8Array(
    BINARY_PREFIX_BYTES + header.byteLength + body.byteLength,
  );
  new DataView(result.buffer, result.byteOffset, BINARY_PREFIX_BYTES)
    .setUint32(0, header.byteLength, true);
  result.set(header, BINARY_PREFIX_BYTES);
  result.set(body, BINARY_PREFIX_BYTES + header.byteLength);
  return result;
}

// The hello capabilities member is optional; when present it is an object whose
// known members are Booleans (`resource_changes: true` also needs `resources:
// true`). Unknown members are ignored.
function validCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  if (
    Object.hasOwn(value, "resources") && typeof value.resources !== "boolean"
  ) return false;
  if (!Object.hasOwn(value, "resource_changes")) return true;
  // Change notifications are an addition to the resource tree.
  return typeof value.resource_changes === "boolean" &&
    (value.resource_changes !== true || value.resources === true);
}

// A node id is a non-empty string of at most 16,384 UTF-8 bytes. The root is
// null or omitted where allowed.
function validNodeId(value: unknown, allowRoot: boolean): boolean {
  if (value === null || value === undefined) return allowRoot;
  return typeof value === "string" && value.length > 0 &&
    encoder.encode(value).byteLength <= MAX_NODE_ID_BYTES;
}

function parseChildrenQuery(params: JsonObject): ChildrenQuery | null {
  if (!validNodeId(params.node, true)) return null;
  const offset = Object.hasOwn(params, "offset") ? params.offset : 0;
  const limit = Object.hasOwn(params, "limit") ? params.limit : 200;
  if (
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 500
  ) return null;
  return {
    node: typeof params.node === "string" ? params.node : null,
    offset,
    limit,
  };
}

// Checks a successful session scope result against the request. A
// resources/open result is the opened view's descriptor, which the view/open
// notification already registered, so only its shape is checked.
function validResourceResult(
  pending: PendingRequest,
  result: unknown,
): boolean {
  if (!isObject(result)) return false;
  if (pending.method !== "resources/children") return true;
  const query = pending.children;
  if (!query) return false;
  const children = result.children;
  const total = result.total_children;
  const next = result.next_offset;
  if (
    !Object.hasOwn(result, "node") || result.node !== query.node ||
    result.offset !== query.offset || !Array.isArray(children) ||
    children.length > query.limit ||
    !Object.hasOwn(result, "total_children") ||
    !(total === null ||
      (typeof total === "number" && Number.isSafeInteger(total) &&
        total >= 0)) ||
    !Object.hasOwn(result, "next_offset")
  ) return false;
  if (next === null) return true;
  return children.length > 0 && next === query.offset + children.length;
}

function isTerminalResponse(message: JsonObject): boolean {
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasResult === hasError) return false;
  if (hasResult) return true;
  return isObject(message.error) && typeof message.error.code === "string";
}

// A refresh response is an error object or the exact acknowledgement of the
// request: same view, the requested generation as previous_generation, and the
// next generation.
function isRefreshResponse(
  pending: PendingRequest,
  message: JsonObject,
): boolean {
  if (Object.hasOwn(message, "error")) return true;
  const result = message.result;
  const scope = pending.scope;
  return scope.kind === "view" && isObject(result) &&
    result.view === scope.view &&
    result.previous_generation === scope.generation &&
    result.generation === scope.generation + 1 &&
    result.refreshed === true;
}

function isTrackResponse(
  pending: PendingRequest,
  message: JsonObject,
): boolean {
  if (Object.hasOwn(message, "error")) return true;
  const result = message.result;
  const scope = pending.scope;
  return scope.kind === "view" && isObject(result) &&
    result.view === scope.view &&
    (result.generation === scope.generation ||
      result.generation === scope.generation + 1) &&
    sanitizeTracking(result.tracking) !== null;
}

// The tracking object of the producer's view/tracking and view/track result, reduced to
// the fields the protocol defines; null when it is not valid.
function sanitizeTracking(value: unknown): JsonObject | null {
  if (!isObject(value) || typeof value.name !== "string") return null;
  const state = value.state;
  if (state !== "active" && state !== "paused" && state !== "lost") return null;
  const tracking: JsonObject = { name: value.name.slice(0, 4096), state };
  // The reason is a token; unknown values pass so the protocol can grow.
  if (
    typeof value.reason === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.reason)
  ) {
    tracking.reason = value.reason;
  }
  if (typeof value.message === "string") {
    tracking.message = value.message.slice(0, 1024);
  }
  return tracking;
}

function validStreamProgress(
  value: JsonObject,
  maxRows: number,
): StreamProgress | null {
  const first = value.first_row,
    count = value.rows_fetched,
    seen = value.rows_seen;
  if (
    ![first, count, seen].every((item) =>
      Number.isSafeInteger(item) && Number(item) >= 0
    ) || Number(count) > maxRows || Number(first) + Number(count) !== seen ||
    typeof value.done !== "boolean"
  ) return null;
  return {
    first_row: Number(first),
    rows_fetched: Number(count),
    rows_seen: Number(seen),
    done: value.done,
  };
}
