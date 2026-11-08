import {
  createSequentialCache,
  decodeArrowPage,
  formatUnavailableRowRanges,
  mergeSequentialCacheInfo,
  recordSequentialProgress,
  SEQUENTIAL_CACHE_PAGES,
  SEQUENTIAL_TOTAL_CACHE_BYTES,
  sequentialPageRows,
  trimSequentialCaches,
} from "/assets/sequential.js";
import {
  arrowTreeChildren,
  arrowTreeNode,
  createArrowCellRoot,
  createArrowTreePage,
  openArrowChild,
} from "/assets/arrow_tree.js";
import { createArrowPageCache } from "/assets/arrow_page_cache.js";
import {
  beginOpen,
  canExpand,
  canOpen,
  childPath,
  closeExplorer,
  collapse,
  createExplorer,
  createResourceViewTracker,
  declaresResources,
  endOpen,
  existingChild,
  expand,
  failLoad,
  finishLoad,
  hasMore,
  hiddenCount,
  isCurrent as isResourceFetchCurrent,
  markChanged,
  nodeFor,
  nodeIdOf,
  nodeKey,
  normalizeKind,
  refreshAll,
  refreshDue,
  RESOURCE_PAGE_SIZE,
  rowLabel,
  rowSummaryText,
  startLoad,
  visibleChildren,
} from "/assets/resource_tree.js";
import { decodeRows, querySnapshot } from "/assets/jdv_query.js";
import {
  columnWindow,
  createBrowserTransport,
  fillRemotePage,
} from "/assets/client.js";

const $ = (selector) => document.querySelector(selector);
const status = $("#status");
const sessionsElement = $("#sessions");
const resourcesElement = $("#resources");
const resourcesPanel = $("#resources-panel");
const workspace = $("#workspace");
const tablesElement = $("#tables");
const viewer = $("#viewer");
const treeViewer = $("#tree-viewer");
const titleElement = $("#table-title");
const metaElement = $("#table-meta");
const sortList = $("#sort-list");
const sortFieldset = sortList.closest("fieldset");
const sortColumn = $("#sort-column");
const sortDirection = $("#sort-direction");
const filterColumn = $("#filter-column");
const filterOperator = $("#filter-op");
const filterValue = $("#filter-value");
const filterUpper = $("#filter-upper");
const filterHelp = $("#filter-help");
const filterFieldset = filterHelp.closest("fieldset");
const viewport = $("#column-viewport");
const spacer = $("#column-spacer");
const windowElement = $("#column-window");
const paginationElement = $("#table-pagination");
const warningsElement = $("#warnings");
const treeTitleElement = $("#tree-title");
const treeMetaElement = $("#tree-meta");
const treeBreadcrumb = $("#tree-breadcrumb");
const treeChildList = $("#tree-child-list");
const treePageLabel = $("#tree-page-label");
const treePrevious = $("#tree-previous");
const treeNext = $("#tree-next");
const treeReturn = $("#tree-return");
const treeParentReturn = $("#tree-parent-return");
const gridRefresh = $("#refresh-view");
const treeRefresh = $("#tree-refresh");
const gridTrack = $("#track-view");
const gridTrackState = $("#track-state");
const treeTrack = $("#tree-track");
const treeTrackState = $("#tree-track-state");
const treeAttributes = $("#tree-attributes");
const treeAttributesLabel = $("#tree-attributes-label");
const viewBreadcrumb = $("#view-breadcrumb");
const childOpenStatus = $("#child-open-status");
const sequentialControls = $("#sequential-controls");
const sequentialNext = $("#sequential-next");
const sequentialEarlier = $("#sequential-earlier");
const sequentialProgress = $("#sequential-progress");
const sequentialNotice = $("#sequential-notice");
const PAGE_SIZE = 200;
const TREE_PAGE_SIZE = 200;
const COLUMN_WIDTH = 180;
const ROW_WIDTH = 86;
const knownSessions = new Map();
// Resource Tree explorers by session id; only sessions that declared the
// capability have one.
const explorers = new Map();
const resourceViews = createResourceViewTracker();
const knownTables = new Map();
const tableWaiters = new Map();
const arrowPageCache = createArrowPageCache();
let selected = null;
let nextWindowFrame = 0;
let nextWindowTimer;
let pendingColumnQuery = false;
let streamCacheCapability = null;
let cacheUseClock = 0;

const scheme = location.protocol === "https:" ? "wss:" : "ws:";
const socketUrl = new URL(`${scheme}//${location.host}/ws`);
const token = new URL(location.href).searchParams.get("token");
if (token) socketUrl.searchParams.set("token", token);
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
const transport = createBrowserTransport(socket, {
  onBusy(id, session, reason) {
    if (
      (id && selected?.activeRequestIds.has(id)) ||
      (reason === "wire_credit" && session === selected?.session &&
        selected.activeRequestIds.size > 0)
    ) {
      setStatus("The producer is busy. The request is still waiting.", "busy");
    }
  },
});

socket.addEventListener("open", () => {
  setStatus("Connected. Open a table in R with jdv::jdv_view(x).", "connected");
});
socket.addEventListener("close", () => {
  transport.close();
  cancelColumnWindowUpdate();
  if (selected) selected.epoch++;
  setStatus("Disconnected from the local viewer.", "error");
  viewer.hidden = true;
});
socket.addEventListener("error", () => {
  setStatus("The local viewer connection failed.", "error");
});
socket.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer) {
    try {
      transport.handleBinary(event.data);
    } catch (error) {
      setStatus(
        error?.message ?? "The local viewer sent an invalid binary message.",
        "error",
      );
      socket.close(1007, "Invalid binary message");
    }
    return;
  }
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    setStatus("The local viewer sent an invalid message.", "error");
    return;
  }
  transport.handleMessage(message);
  if (message.type === "welcome") {
    streamCacheCapability = validStreamCacheCapability(
      message.capabilities?.stream_cache,
    );
    for (const entry of message.sessions ?? []) {
      addSession(entry.hello?.params?.session, entry.hello);
      for (const view of entry.views ?? []) {
        addTable(entry.hello?.params?.session, view);
      }
    }
  } else if (message.type === "session/open") {
    addSession(message.session, message.hello);
  } else if (message.type === "session/closed") {
    knownSessions.delete(message.session);
    disposeExplorer(message.session);
    resourceViews.forgetSession(message.session);
    for (const [key, entry] of knownTables) {
      if (entry.session === message.session) {
        entry.cache?.clear();
        entry.arrowPageMetadata?.clear();
        arrowPageCache.deleteView(entry.session, entry.descriptor.view);
        knownTables.delete(key);
      }
    }
    transport.cancelSession(message.session);
    if (selected?.session === message.session) closeSelectedTable();
    renderLists();
  } else if (message.type === "view/open") {
    addTable(message.session, message.message);
  } else if (message.type === "view/closed") {
    const descriptor = message.message?.params;
    if (descriptor) {
      const key = `${message.session}\0${descriptor.view}`;
      const current = knownTables.get(key);
      if (current?.descriptor.generation === descriptor.generation) {
        resourceViews.forget(message.session, descriptor.view);
        current.cache?.clear();
        current.arrowPageMetadata?.clear();
        arrowPageCache.deleteView(message.session, descriptor.view);
        knownTables.delete(key);
      }
      transport.cancelTable(
        message.session,
        descriptor.view,
        descriptor.generation,
        undefined,
        { includeRefresh: true },
      );
      if (
        selected?.session === message.session &&
        selected.descriptor.view === descriptor.view &&
        selected.descriptor.generation === descriptor.generation
      ) closeSelectedTable();
      if (
        selected?.returnTree?.session === message.session &&
        selected.returnTree.descriptor.view === descriptor.view &&
        selected.returnTree.descriptor.generation === descriptor.generation
      ) {
        if (selected.kind === "arrow-cell") {
          closeSelectedTable();
          setStatus("The inspected view was closed.", "error");
        } else {
          selected.returnTree = null;
          treeReturn.hidden = true;
        }
      }
    }
    renderLists();
  } else if (message.type === "notification") {
    const method = message.message?.method;
    if (method === "view/update_failed") {
      // The last good display stays; only the status reports the failure.
      const params = message.message.params;
      const current = knownTables.get(`${message.session}\0${params?.view}`);
      if (current?.descriptor.generation === params?.generation) {
        const title = current.descriptor.title ?? params.view;
        setStatus(
          `Could not update "${title}" (${params.code}): ${params.message}`,
          "error",
        );
      }
    } else if (method === "view/tracking") {
      applyTracking(message.session, message.message.params);
    } else if (method === "resources/changed") {
      resourcesChanged(message.session);
    } else if (method) setStatus(`Producer notification: ${method}`, "info");
  }
});

sequentialNext.addEventListener("click", () => {
  if (selected?.kind === "sequential") loadSequentialPage(selected);
});
sequentialEarlier.addEventListener("click", () => {
  if (selected?.kind === "sequential") loadEarlierCachedPages(selected);
});

$("#sort-add").addEventListener("click", addSortTerm);
$("#filter-apply").addEventListener("click", applyFilter);
$("#filter-clear").addEventListener("click", clearFilter);
filterOperator.addEventListener("change", updateFilterInputs);
filterColumn.addEventListener("change", updateFilterOperators);
viewport.addEventListener("scroll", scheduleColumnWindow);
treePrevious.addEventListener("click", () => {
  if (selected?.kind === "tree" || selected?.kind === "arrow-cell") {
    loadTreeChildren(selected, Math.max(0, selected.offset - TREE_PAGE_SIZE));
  }
});
treeNext.addEventListener("click", () => {
  if (selected?.kind === "tree" || selected?.kind === "arrow-cell") {
    loadTreeChildren(
      selected,
      Math.min(
        Math.max(0, selected.totalChildren - 1),
        selected.offset + TREE_PAGE_SIZE,
      ),
    );
  }
});
gridRefresh.addEventListener("click", () => {
  if (selected?.kind === "grid") {
    refreshView(selected.session, selected.descriptor, gridRefresh);
  }
});
treeRefresh.addEventListener("click", () => {
  if (selected?.kind === "tree") {
    refreshView(selected.session, selected.descriptor, treeRefresh);
  }
});
gridTrack.addEventListener("click", () => {
  if (selected?.kind === "grid") {
    trackView(selected.session, selected.descriptor, gridTrack);
  }
});
treeTrack.addEventListener("click", () => {
  if (selected?.kind === "tree") {
    trackView(selected.session, selected.descriptor, treeTrack);
  }
});
treeAttributes.addEventListener("change", () => {
  if (selected?.kind === "tree") loadTreeChildren(selected, 0);
});
treeReturn.addEventListener("click", returnToTree);
treeParentReturn.addEventListener("click", returnToTree);
globalThis.addEventListener("resize", updateColumnScrollExtent);
new ResizeObserver(scheduleColumnWindow).observe(viewport);

function setStatus(message, state = "info") {
  status.textContent = message;
  status.dataset.state = state;
}

function addSession(id, hello) {
  if (typeof id !== "string") return;
  knownSessions.set(id, hello?.params ?? {});
  renderLists();
  ensureExplorer(id);
}

function validStreamCacheCapability(value) {
  return value && typeof value === "object" && value.version === 1 &&
      Number.isSafeInteger(value.max_total_bytes) &&
      value.max_total_bytes > 0 && Number.isSafeInteger(value.max_view_bytes) &&
      value.max_view_bytes > 0
    ? value
    : null;
}

function addTable(session, message) {
  const descriptor = message?.params;
  if (
    typeof session !== "string" || typeof descriptor?.view !== "string" ||
    !Number.isSafeInteger(descriptor.generation)
  ) return;
  const key = `${session}\0${descriptor.view}`;
  const previous = knownTables.get(key);
  if (
    previous && descriptor.generation <= previous.descriptor.generation
  ) return;
  resourceViews.note(session, descriptor);
  previous?.cache?.clear();
  if (previous) {
    previous.arrowPageMetadata?.clear();
    arrowPageCache.deleteView(session, descriptor.view);
  }
  const replaceSelected = selected?.session === session &&
    selected.descriptor.view === descriptor.view &&
    selected.descriptor.generation < descriptor.generation;
  // A refreshed child stays reachable from the same parent view.
  const keptReturn = replaceSelected && typeof descriptor.parent === "string" &&
      selected.returnTree?.session === session &&
      selected.returnTree.descriptor.view === descriptor.parent &&
      knownTables.get(`${session}\0${descriptor.parent}`)?.descriptor
          .generation === selected.returnTree.descriptor.generation
    ? selected.returnTree
    : null;
  if (replaceSelected) closeSelectedTable();
  knownTables.set(key, {
    session,
    descriptor,
    progress: { watermark: 0, received: 0, done: false, gap: null },
    cache: descriptor.access === "sequential" ? createSequentialCache() : null,
    arrowPageMetadata: new Map(),
    cachePages: new Map(),
    cacheInfo: null,
    cacheCatalogCursor: null,
    cacheUse: ++cacheUseClock,
  });
  renderLists();
  const waiters = tableWaiters.get(key);
  if (waiters) {
    tableWaiters.delete(key);
    for (const wake of waiters) wake();
  }
  if (replaceSelected) openView(session, descriptor, keptReturn);
}

// A child view is registered from the producer's view/open notification, which precedes
// the object/open response. Return its record, waiting briefly if the
// notification has not been processed yet.
async function announcedTable(session, view, generation, timeoutMs = 2000) {
  const key = `${session}\0${view}`;
  const lookup = () => {
    const record = knownTables.get(key);
    return record?.descriptor.generation === generation ? record : null;
  };
  const found = lookup();
  if (found) return found;
  await new Promise((resolve) => {
    const waiters = tableWaiters.get(key) ?? [];
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const current = tableWaiters.get(key)?.filter((item) => item !== wake);
      if (current?.length) tableWaiters.set(key, current);
      else tableWaiters.delete(key);
      resolve();
    }, timeoutMs);
    waiters.push(wake);
    tableWaiters.set(key, waiters);
  });
  return lookup();
}

function arrowPageKey(session, view, generation, page) {
  return JSON.stringify([session, view, generation, page]);
}

function retainArrowPage(record, payload, metadata) {
  const page = metadata.cache_page?.page ?? metadata.page;
  if (
    !Number.isSafeInteger(page) || page < 0 ||
    !Number.isSafeInteger(metadata.first_row) || metadata.first_row < 0 ||
    !Number.isSafeInteger(metadata.rows_fetched) ||
    metadata.rows_fetched < 0 ||
    !Number.isSafeInteger(metadata.rows_seen) ||
    metadata.rows_seen !== metadata.first_row + metadata.rows_fetched ||
    typeof metadata.done !== "boolean" ||
    !(payload instanceof ArrayBuffer || payload instanceof Uint8Array)
  ) return;
  const pageMetadata = {
    page,
    first_row: metadata.first_row,
    rows_fetched: metadata.rows_fetched,
    rows_seen: metadata.rows_seen,
    done: metadata.done,
    byte_length: payload.byteLength,
  };
  record.arrowPageMetadata.set(page, pageMetadata);
  while (record.arrowPageMetadata.size > 256) {
    const oldest = Math.min(...record.arrowPageMetadata.keys());
    record.arrowPageMetadata.delete(oldest);
  }
  arrowPageCache.set(
    arrowPageKey(
      record.session,
      record.descriptor.view,
      record.descriptor.generation,
      page,
    ),
    payload,
    pageMetadata,
    {
      session: record.session,
      view: record.descriptor.view,
      generation: record.descriptor.generation,
    },
  );
}

function normalizedCapabilities(descriptor) {
  const capabilityNames = [
    "seek",
    "sort",
    "filter",
    "known_total",
    "next",
    "children",
    "refresh",
    "track",
  ];
  if (
    !descriptor || typeof descriptor !== "object" ||
    (descriptor.capabilities !== undefined &&
      (descriptor.capabilities === null ||
        typeof descriptor.capabilities !== "object" ||
        Array.isArray(descriptor.capabilities)))
  ) return null;
  const supplied = descriptor.capabilities ?? {};
  if (
    capabilityNames.some((name) =>
      Object.hasOwn(supplied, name) && typeof supplied[name] !== "boolean"
    )
  ) return null;
  const capabilities = {
    ...supplied,
    ...Object.fromEntries(capabilityNames.map((name) => [
      name,
      Object.hasOwn(supplied, name) ? supplied[name] : false,
    ])),
  };
  descriptor.capabilities = capabilities;
  return capabilities;
}

function supportsSequentialView(descriptor, capabilities) {
  try {
    sequentialPageRows(descriptor);
  } catch {
    return false;
  }
  return descriptor.encoding === "arrow-ipc" &&
    descriptor.nrow === null && Number.isSafeInteger(descriptor.ncol) &&
    descriptor.ncol >= 0 &&
    Array.isArray(descriptor.columns) &&
    capabilities.next === true && capabilities.seek === false &&
    capabilities.sort === false && capabilities.filter === false &&
    capabilities.known_total === false && capabilities.children === false &&
    capabilities.refresh === false && capabilities.track === false;
}

function supportsTreeView(descriptor, capabilities) {
  return descriptor.access === "random" &&
    descriptor.encoding === "jdv-json" &&
    capabilities.seek === true && capabilities.sort === false &&
    capabilities.filter === false && capabilities.known_total === true &&
    capabilities.next === false && capabilities.children === true;
}

function supportsGridView(descriptor, capabilities) {
  if (
    (descriptor.access !== "snapshot" && descriptor.access !== "random") ||
    descriptor.encoding !== "jdv-json" ||
    !Number.isSafeInteger(descriptor.ncol) || descriptor.ncol < 0 ||
    !Array.isArray(descriptor.columns) ||
    !Object.hasOwn(descriptor, "collation") ||
    !["C", "locale"].includes(descriptor.collation)
  ) return false;
  if (descriptor.access === "random") {
    return Number.isSafeInteger(descriptor.nrow) && descriptor.nrow >= 0 &&
      capabilities.seek === true && capabilities.known_total === true;
  }
  return (descriptor.nrow === null ||
    (Number.isSafeInteger(descriptor.nrow) && descriptor.nrow >= 0)) &&
    descriptor.data !== null && typeof descriptor.data === "object" &&
    !Array.isArray(descriptor.data);
}

function hasRequiredGridFields(descriptor) {
  return typeof descriptor.view === "string" && descriptor.view.length > 0 &&
    Number.isSafeInteger(descriptor.generation) && descriptor.generation > 0 &&
    Object.hasOwn(descriptor, "nrow") &&
    Object.hasOwn(descriptor, "ncol") &&
    Array.isArray(descriptor.columns);
}

function viewSupport(descriptor) {
  const capabilities = normalizedCapabilities(descriptor);
  if (
    !capabilities || typeof descriptor.kind !== "string" ||
    typeof descriptor.access !== "string" ||
    typeof descriptor.encoding !== "string"
  ) return false;
  if (descriptor.kind === "grid" && !hasRequiredGridFields(descriptor)) {
    return false;
  }
  if (descriptor.kind === "grid" && descriptor.access === "sequential") {
    return supportsSequentialView(descriptor, capabilities);
  }
  if (descriptor.kind === "tree") {
    return supportsTreeView(descriptor, capabilities);
  }
  if (descriptor.kind === "grid") {
    return supportsGridView(descriptor, capabilities);
  }
  return false;
}

function countLabel(value, noun) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return `Unknown ${noun}s`;
  }
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function queryCountLabel(total, totalUnfiltered) {
  const count = Number.isSafeInteger(total) && total >= 0 ? total : "Unknown";
  const unfiltered = Number.isSafeInteger(totalUnfiltered) &&
      totalUnfiltered >= 0
    ? totalUnfiltered
    : "Unknown";
  return `${count} of ${unfiltered} rows`;
}

function setTableMeta(state, total, totalUnfiltered) {
  metaElement.textContent = `${queryCountLabel(total, totalUnfiltered)} · ${
    countLabel(state.descriptor.ncol, "column")
  } · ${state.session}`;
}

function refreshAvailable(descriptor) {
  return descriptor?.capabilities?.refresh === true;
}

// Ask the producer to rebuild a view. The reply only acknowledges the operation: the new
// generation arrives as view/open and replaces the display, which starts from
// a clean query state. The reply never changes what is shown, so a late
// acknowledgement cannot move the display back.
function refreshView(session, descriptor, control) {
  const current = knownTables.get(`${session}\0${descriptor.view}`)
    ?.descriptor ?? descriptor;
  if (control) control.disabled = true;
  const promise = transport.request(session, "view/refresh", {
    view: current.view,
    generation: current.generation,
  });
  promise.then(
    () => {
      if (control) control.disabled = false;
    },
    (error) => {
      if (control) control.disabled = false;
      if (error?.name === "AbortError") return;
      setStatus(error?.message ?? "Could not refresh the view.", "error");
    },
  );
  return promise;
}

const TRACK_STATES = ["active", "paused", "lost"];

function trackingOf(descriptor) {
  const tracking = descriptor?.tracking;
  return typeof tracking?.name === "string" &&
      TRACK_STATES.includes(tracking.state)
    ? tracking
    : null;
}

function trackLabel(tracking) {
  if (tracking.state === "active") return `Following ${tracking.name}`;
  if (tracking.state === "paused") return `Paused ${tracking.name}`;
  const detail = typeof tracking.message === "string"
    ? tracking.message
    : tracking.reason;
  return `Lost ${tracking.name}${
    typeof detail === "string" ? `: ${detail}` : ""
  }`;
}

function trackButtonLabel(tracking) {
  return tracking.state === "active" ? "Pause following" : "Resume following";
}

// Whether the host may stop or resume following; a lost view cannot.
function trackAvailable(descriptor) {
  return descriptor?.capabilities?.track === true &&
    trackingOf(descriptor) !== null &&
    trackingOf(descriptor).state !== "lost";
}

// Ask the producer to stop or resume following the variable of a view. The state change
// arrives as view/tracking, or as a new view/open when resuming rebuilds the
// view; the reply only acknowledges it.
function trackView(session, descriptor, control) {
  const current = knownTables.get(`${session}\0${descriptor.view}`)
    ?.descriptor ?? descriptor;
  const tracking = trackingOf(current);
  if (!tracking) return Promise.resolve();
  if (control) control.disabled = true;
  const promise = transport.request(session, "view/track", {
    view: current.view,
    generation: current.generation,
    enabled: tracking.state !== "active",
  });
  promise.then(
    () => {
      if (control) control.disabled = false;
    },
    (error) => {
      if (control) control.disabled = false;
      if (error?.name === "AbortError") return;
      setStatus(error?.message ?? "Could not change following.", "error");
    },
  );
  return promise;
}

// The producer announced a tracking change without a new view/open. Only the generation
// still shown is updated; the descriptor is changed in place so the open view
// and the list agree.
function applyTracking(session, params) {
  const record = knownTables.get(`${session}\0${params?.view}`);
  const tracking = params?.tracking;
  if (
    !record || record.descriptor.generation !== params.generation ||
    typeof tracking?.name !== "string" ||
    !TRACK_STATES.includes(tracking.state)
  ) return;
  const descriptor = record.descriptor;
  descriptor.tracking = tracking;
  descriptor.capabilities = {
    ...descriptor.capabilities,
    track: tracking.state !== "lost",
  };
  updateRefreshControls();
  renderLists();
}

function updateTrackControls() {
  const descriptor = selected?.descriptor;
  const supported = selected?.kind === "grid" || selected?.kind === "tree";
  const tracking = supported ? trackingOf(descriptor) : null;
  for (
    const [kind, button, label] of [
      ["grid", gridTrack, gridTrackState],
      ["tree", treeTrack, treeTrackState],
    ]
  ) {
    const shown = tracking !== null && selected.kind === kind;
    label.hidden = !shown;
    label.textContent = shown ? trackLabel(tracking) : "";
    button.hidden = !(shown && trackAvailable(descriptor));
    button.disabled = false;
    button.textContent = shown ? trackButtonLabel(tracking) : "";
  }
}

function updateRefreshControls() {
  updateTrackControls();
  const descriptor = selected?.descriptor;
  const available = refreshAvailable(descriptor) &&
    (selected.kind === "grid" || selected.kind === "tree");
  gridRefresh.hidden = !(available && selected.kind === "grid");
  gridRefresh.disabled = false;
  treeRefresh.hidden = !(available && selected.kind === "tree");
  treeRefresh.disabled = false;
}

function renderLists() {
  sessionsElement.replaceChildren();
  for (const [id, info] of knownSessions) {
    const item = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = `Session ${id}`;
    const detail = document.createElement("p");
    detail.className = "muted";
    const producer = info.producer;
    const runtime = producer.runtime;
    detail.textContent = `${producer.name} ${producer.version}${
      runtime ? ` · ${runtime.name} ${runtime.version}` : ""
    }`;
    item.append(heading, detail);
    sessionsElement.append(item);
  }

  tablesElement.replaceChildren();
  for (const { session, descriptor } of knownTables.values()) {
    const item = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = descriptor.title ??
      (descriptor.kind === "tree" ? "Untitled object" : "Untitled table");
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = descriptor.kind === "tree"
      ? `Object tree · ${treeDescriptorText(descriptor)} · ${session}`
      : `${countLabel(descriptor.nrow, "row")} · ${
        countLabel(descriptor.ncol, "column")
      } · ${session}`;
    const button = document.createElement("button");
    button.type = "button";
    const support = viewSupport(descriptor);
    button.textContent = support
      ? descriptor.kind === "tree" ? "Open object" : "Open view"
      : "Unsupported view";
    button.disabled = !support;
    if (support) {
      button.addEventListener("click", () => openView(session, descriptor));
    }
    item.append(heading, detail, button);
    if (refreshAvailable(descriptor)) {
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.textContent = "Refresh";
      refresh.dataset.action = "refresh-view";
      refresh.addEventListener(
        "click",
        () => refreshView(session, descriptor, refresh),
      );
      item.append(refresh);
    }
    const tracking = trackingOf(descriptor);
    if (tracking) {
      const state = document.createElement("span");
      state.className = "track-state muted";
      state.dataset.role = "track-state";
      state.textContent = trackLabel(tracking);
      item.append(state);
      if (trackAvailable(descriptor)) {
        const track = document.createElement("button");
        track.type = "button";
        track.textContent = trackButtonLabel(tracking);
        track.dataset.action = "track-view";
        track.addEventListener(
          "click",
          () => trackView(session, descriptor, track),
        );
        item.append(track);
      }
    }
    if (
      typeof descriptor.parent === "string" ||
      resourceViews.has(session, descriptor.view)
    ) {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close view";
      close.dataset.action = "close-view";
      close.addEventListener("click", () => {
        close.disabled = true;
        const promise = transport.request(session, "view/close", {
          view: descriptor.view,
          generation: descriptor.generation,
        });
        promise.catch((error) => {
          close.disabled = false;
          setStatus(error?.message ?? "Could not close the view.", "error");
        });
      });
      item.append(close);
    }
    tablesElement.append(item);
  }
}

function openView(session, descriptor, returnTree = null, restored = null) {
  if (!viewSupport(descriptor)) {
    setStatus("This view format is not supported by this viewer.", "error");
    return;
  }
  if (descriptor.kind === "tree") {
    openTree(session, descriptor, returnTree);
    return;
  }
  if (descriptor.access === "sequential") {
    openSequential(session, descriptor, returnTree);
    return;
  }
  closeSelectedTable();
  sequentialControls.hidden = true;
  $(".query-tools").hidden = false;
  const columns = Array.isArray(descriptor.columns) ? descriptor.columns : [];
  selected = restored ?? {
    kind: "grid",
    session,
    descriptor,
    columns,
    sort: [],
    filter: null,
    epoch: 0,
    page: 1,
    activeRequestIds: new Set(),
    queryRequestIds: new Set(),
    returnTree,
    table: null,
    window: { start: 0, end: 0, columns: [], offsetPx: 0, totalWidth: 0 },
  };
  selected.childOpening = false;
  updateRefreshControls();
  renderViewBreadcrumbs();
  viewer.hidden = false;
  treeViewer.hidden = true;
  treeParentReturn.hidden = true;
  treeReturn.hidden = returnTree === null;
  titleElement.textContent = descriptor.title ?? "Untitled table";
  metaElement.textContent = `${countLabel(descriptor.nrow, "row")} · ${
    countLabel(descriptor.ncol, "column")
  } · ${session}`;
  warningsElement.replaceChildren();
  paginationElement.replaceChildren();
  populateColumnChoices();
  spacer.style.width = `${
    columnScrollExtent(ROW_WIDTH + columns.length * COLUMN_WIDTH)
  }px`;
  viewport.scrollLeft = restored?.scrollLeft ?? 0;
  const windowState = calculateColumnWindow();
  selected.window = windowState;
  spacer.style.width = `${columnScrollExtent(windowState.totalWidth)}px`;
  windowElement.style.transform = `translateX(${windowState.offsetPx}px)`;
  updateRowColumnCompensation();
  windowElement.style.width = `${
    ROW_WIDTH + windowState.columns.length * COLUMN_WIDTH
  }px`;
  const initialColumns = buildTableColumns(windowState.columns);
  selected.table = new globalThis.Tabulator(windowElement, {
    height: "460px",
    layout: "fitData",
    columnDefaults: {
      width: COLUMN_WIDTH,
      minWidth: COLUMN_WIDTH,
      maxWidth: COLUMN_WIDTH,
      resizable: false,
    },
    columns: initialColumns,
    index: "source_row",
    placeholder: "No rows match this query.",
    pagination: descriptor.capabilities.seek === true &&
      descriptor.capabilities.known_total === true,
    paginationMode: "remote",
    paginationSize: PAGE_SIZE,
    paginationInitialPage: selected.page,
    paginationButtonCount: 5,
    paginationCounter: "rows",
    paginationElement,
    sortMode: "remote",
    filterMode: "remote",
    ajaxURL: "/query",
    ajaxRequestFunc: (_url, _config, params) => requestRows(params),
  });
  setStatus("Loading table…", "loading");
  updateFilterOperators();
  renderSortTerms();
  if (restored?.form) restoreQueryForm(restored.form);
}

function closeSelectedTable() {
  if (!selected) return;
  if (selected.kind === "grid") {
    selected.scrollLeft = viewport.scrollLeft;
    selected.form = captureQueryForm();
  }
  cancelColumnWindowUpdate();
  selected.epoch++;
  transport.cancelTable(
    selected.session,
    selected.descriptor.view,
    selected.descriptor.generation,
    "The selected table was closed.",
  );
  selected.table?.destroy();
  sequentialControls.hidden = true;
  paginationElement.replaceChildren();
  treeChildList.replaceChildren();
  treeBreadcrumb.replaceChildren();
  selected = null;
  viewer.hidden = true;
  treeViewer.hidden = true;
  treeReturn.hidden = true;
  treeParentReturn.hidden = true;
  gridRefresh.hidden = true;
  treeRefresh.hidden = true;
  viewBreadcrumb.replaceChildren();
  childOpenStatus.hidden = true;
}

function treeDescriptorText(descriptor) {
  const classes = Array.isArray(descriptor.class)
    ? descriptor.class.filter((value) => typeof value === "string").join(", ")
    : "";
  const type = typeof descriptor.type === "string" ? descriptor.type : "";
  if (classes && type) return `${classes} (${type})`;
  return classes || type || "unknown class";
}

function openTree(session, descriptor, returnTree = null) {
  closeSelectedTable();
  selected = {
    kind: "tree",
    session,
    descriptor,
    path: [],
    breadcrumbs: [{ path: [], label: descriptor.title ?? "Object" }],
    offset: 0,
    totalChildren: 0,
    activeRequestIds: new Set(),
    queryRequestIds: new Set(),
    epoch: 0,
    children: [],
    returnTree,
  };
  updateRefreshControls();
  renderViewBreadcrumbs();
  viewer.hidden = true;
  treeViewer.hidden = false;
  treeParentReturn.hidden = returnTree === null;
  treeTitleElement.textContent = descriptor.title ?? "Untitled object";
  treeMetaElement.textContent = treeDescriptorText(descriptor) +
    " · " + session;
  treeChildList.replaceChildren();
  renderTreeBreadcrumbs(selected);
  loadTreeChildren(selected, 0);
}

function cancelQueryRequests(state) {
  for (const id of state.queryRequestIds) {
    transport.cancel(id, "A newer page or object path replaced this request.");
    state.activeRequestIds.delete(id);
  }
  state.queryRequestIds.clear();
}

function loadTreeChildren(state, offset) {
  if (state.kind === "arrow-cell") {
    loadArrowTreeChildren(state, offset);
    return;
  }
  if (selected !== state || state.kind !== "tree") return;
  state.epoch++;
  const epoch = state.epoch;
  cancelQueryRequests(state);
  state.offset = Math.max(0, offset);
  setStatus("Loading object children…", "loading");
  treePrevious.disabled = state.offset === 0;
  treeNext.disabled = true;
  const promise = transport.request(
    state.session,
    "object/children",
    {
      view: state.descriptor.view,
      generation: state.descriptor.generation,
      path: state.path,
      offset: state.offset,
      limit: TREE_PAGE_SIZE,
      attributes: treeAttributes.checked,
    },
    60_000,
  );
  const id = promise.id;
  if (id) {
    state.activeRequestIds.add(id);
    state.queryRequestIds.add(id);
  }
  promise.then((response) => {
    if (selected !== state || state.epoch !== epoch) return;
    const result = response?.result;
    if (
      !result || result.view !== state.descriptor.view ||
      result.generation !== state.descriptor.generation ||
      !Array.isArray(result.path) ||
      JSON.stringify(result.path) !== JSON.stringify(state.path) ||
      result.offset !== state.offset || !Array.isArray(result.children) ||
      !Number.isSafeInteger(result.total_children) ||
      result.total_children < 0 || result.children.length > TREE_PAGE_SIZE
    ) throw new Error("The producer returned an invalid object children page.");
    state.totalChildren = result.total_children;
    state.children = result.children;
    renderTreePage(state);
    setStatus("Connected.", "connected");
  }).catch((error) => {
    if (selected !== state || state.epoch !== epoch) return;
    if (error?.name === "AbortError") return;
    treeChildList.replaceChildren();
    treeMetaElement.textContent = error?.code
      ? error.code + ": " + error.message
      : error?.message ?? String(error);
    setStatus("The object request failed.", "error");
  }).finally(() => {
    if (id) {
      state.activeRequestIds.delete(id);
      state.queryRequestIds.delete(id);
    }
  });
}

function renderTreeBreadcrumbs(state) {
  treeBreadcrumb.replaceChildren();
  state.breadcrumbs.forEach((crumb, depth) => {
    const item = document.createElement("li");
    if (depth === state.breadcrumbs.length - 1) {
      item.textContent = crumb.label;
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.treeDepth = String(depth);
      button.textContent = crumb.label;
      button.addEventListener("click", () => {
        state.breadcrumbs = state.breadcrumbs.slice(0, depth + 1);
        state.path = crumb.path;
        renderTreeBreadcrumbs(state);
        loadTreeChildren(state, 0);
      });
      item.append(button);
    }
    treeBreadcrumb.append(item);
  });
}

function renderTreePage(state) {
  treeAttributesLabel.hidden = state.kind !== "tree";
  treeChildList.replaceChildren();
  for (const [position, child] of state.children.entries()) {
    if (!child || typeof child !== "object") continue;
    const item = document.createElement("li");
    item.dataset.childIndex = String(
      child.index ?? state.offset + position + 1,
    );
    const label = rowLabel(child);
    if (child.has_children === true) {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.dataset.action = "expand-child";
      expand.textContent = label;
      expand.addEventListener("click", () => {
        if (state.kind === "arrow-cell") {
          state.path = openArrowChild(state.root, state.path, child.index);
        } else {
          if (!Array.isArray(child.path)) return;
          state.path = child.path;
        }
        state.breadcrumbs.push({ path: child.path, label });
        renderTreeBreadcrumbs(state);
        loadTreeChildren(state, 0);
      });
      item.append(expand);
    } else {
      const text = document.createElement("span");
      text.textContent = label;
      item.append(text);
    }
    item.append(summaryElement(child));
    if (typeof child.unavailable === "string") {
      item.append(unavailableElement(child.unavailable));
    } else if (child.viewable === true && Array.isArray(child.path)) {
      const open = document.createElement("button");
      open.type = "button";
      open.dataset.action = "open-child";
      open.textContent = "Open view";
      open.addEventListener("click", () => openChild(state, child.path));
      item.append(open);
    }
    treeChildList.append(item);
  }
  const start = state.totalChildren === 0 ? 0 : state.offset + 1;
  const end = Math.min(
    state.totalChildren,
    state.offset + state.children.length,
  );
  treePageLabel.textContent = start + "–" + end + " of " +
    state.totalChildren + " children";
  treePrevious.disabled = state.offset === 0;
  treeNext.disabled = end >= state.totalChildren;
}

function loadArrowTreeChildren(state, offset) {
  if (selected !== state || state.kind !== "arrow-cell") return;
  state.offset = Math.max(0, offset);
  const node = arrowTreeNode(state.root, state.path);
  const result = arrowTreeChildren(
    state.root,
    state.path,
    state.offset,
    TREE_PAGE_SIZE,
  );
  state.totalChildren = result.total_children;
  state.children = result.children;
  treeTitleElement.textContent = node.label;
  treeMetaElement.textContent = `${node.type} · ${node.summary}`;
  renderTreePage(state);
  setStatus("Connected.", "connected");
}

function pageMetadataForRow(record, rowIndex) {
  const row = rowIndex;
  const all = new Map(record.arrowPageMetadata);
  for (const [page, metadata] of record.cachePages ?? []) {
    if (!all.has(page)) all.set(page, metadata);
  }
  return [...all.values()].find((metadata) =>
    Number.isSafeInteger(metadata.first_row) &&
    Number.isSafeInteger(metadata.rows_fetched) &&
    metadata.rows_fetched > 0 && row >= metadata.first_row &&
    row < metadata.first_row + metadata.rows_fetched
  ) ?? null;
}

function showInspectFailure(message) {
  childOpenStatus.hidden = false;
  childOpenStatus.dataset.state = "error";
  childOpenStatus.textContent = message;
}

async function ensureArrowPage(state, metadata, epoch) {
  const record = sequentialRecord(state);
  const key = arrowPageKey(
    state.session,
    state.descriptor.view,
    state.descriptor.generation,
    metadata.page,
  );
  const cached = arrowPageCache.get(key);
  if (cached) {
    return { ...cached, metadata: { ...metadata, ...cached.metadata } };
  }
  if (!state.cacheEnabled) return null;

  let hostMetadata = record.cachePages.get(metadata.page);
  if (!hostMetadata) {
    const info = await requestCacheInfo(state, metadata.page - 1, 1);
    if (!isCurrent(state, epoch)) return null;
    mergeCacheInfo(record, info);
    hostMetadata = info.pages.find((page) => page.page === metadata.page);
    if (!hostMetadata) return null;
    record.cachePages.set(metadata.page, hostMetadata);
    pruneCacheCatalog(record);
  }

  const response = await cacheRequest(
    state,
    "stream/cache/get",
    {
      view: state.descriptor.view,
      generation: state.descriptor.generation,
      page: metadata.page,
      max_bytes: 4 * 1024 * 1024,
    },
    30_000,
  );
  if (!isCurrent(state, epoch)) return null;
  const result = response?.result;
  const page = result?.cache_page;
  if (
    !response.binary || !page || page.page !== metadata.page ||
    result.view !== state.descriptor.view ||
    result.generation !== state.descriptor.generation ||
    result.first_row !== page.first_row ||
    result.rows_fetched !== page.rows_fetched ||
    result.rows_seen !== page.rows_seen || result.done !== page.done ||
    !validCachePageMetadata(page) ||
    result.transfer?.encoding !== "arrow-ipc" ||
    result.transfer.byte_length !== response.binary.byteLength ||
    page.byte_length !== response.binary.byteLength
  ) throw new Error("The host returned an invalid Arrow inspection page.");
  retainArrowPage(record, response.binary, result);
  return arrowPageCache.get(key);
}

async function inspectArrowCell(state, rowIndex, column) {
  if (selected !== state || state.kind !== "sequential") return;
  const epoch = state.epoch;
  const record = sequentialRecord(state);
  const metadata = pageMetadataForRow(record, rowIndex);
  if (!metadata) {
    showInspectFailure("This value's Arrow page is no longer available.");
    return;
  }
  childOpenStatus.hidden = false;
  childOpenStatus.dataset.state = "waiting";
  childOpenStatus.textContent = "Loading the cached Arrow page…";
  try {
    const entry = await ensureArrowPage(state, metadata, epoch);
    if (!isCurrent(state, epoch)) return;
    if (!entry) {
      showInspectFailure(
        "This value's Arrow page is no longer retained by the browser or host.",
      );
      return;
    }
    const page = createArrowTreePage(
      new Uint8Array(entry.payload),
      state.descriptor,
      entry.metadata,
    );
    const root = createArrowCellRoot(page, rowIndex, column);
    const node = arrowTreeNode(root);
    openArrowTree(state, root, node);
  } catch (error) {
    if (!isCurrent(state, epoch) || error?.name === "AbortError") return;
    showInspectFailure(
      `Could not inspect this value: ${error?.message ?? String(error)}`,
    );
  }
}

function openArrowTree(parent, root, node) {
  closeSelectedTable();
  selected = {
    kind: "arrow-cell",
    session: parent.session,
    descriptor: parent.descriptor,
    root,
    path: [],
    breadcrumbs: [{ path: [], label: node.label }],
    offset: 0,
    totalChildren: node.total_children,
    children: [],
    activeRequestIds: new Set(),
    queryRequestIds: new Set(),
    epoch: 0,
    returnTree: parent,
  };
  renderViewBreadcrumbs();
  viewer.hidden = true;
  treeViewer.hidden = false;
  treeParentReturn.hidden = false;
  treeReturn.hidden = true;
  treeChildList.replaceChildren();
  renderTreeBreadcrumbs(selected);
  loadArrowTreeChildren(selected, 0);
}

async function openChild(state, path) {
  if (!isActiveView(state) || state.childOpening) return;
  state.childOpening = true;
  childOpenStatus.hidden = false;
  childOpenStatus.dataset.state = "waiting";
  childOpenStatus.textContent =
    "Opening the captured value. Waiting for the producer…";
  const promise = transport.request(
    state.session,
    "object/open",
    {
      view: state.descriptor.view,
      generation: state.descriptor.generation,
      path,
    },
    60_000,
  );
  const id = promise.id;
  if (id) state.activeRequestIds.add(id);
  try {
    const response = await promise;
    if (!isActiveView(state)) return;
    const reply = response?.result;
    if (
      typeof reply?.view !== "string" ||
      !Number.isSafeInteger(reply.generation)
    ) {
      throw new Error("The producer returned an invalid child view reply.");
    }
    // The response only identifies the child; its view/open notification
    // registered it, and a child closed meanwhile is never reopened here.
    const record = await announcedTable(
      state.session,
      reply.view,
      reply.generation,
    );
    if (!isActiveView(state)) return;
    const descriptor = record?.descriptor;
    if (!descriptor) {
      throw new Error("The child view is no longer open.");
    }
    if (!viewSupport(descriptor)) {
      throw new Error(
        "The producer returned an invalid child view descriptor.",
      );
    }
    if (descriptor.kind === "tree") {
      openTree(state.session, descriptor, state);
    } else {
      openView(state.session, descriptor, state);
    }
  } catch (error) {
    if (!isActiveView(state)) return;
    if (error?.name !== "AbortError") {
      childOpenStatus.dataset.state = "error";
      childOpenStatus.textContent = error?.code
        ? error.code + ": " + error.message
        : error?.message ?? String(error);
    }
  } finally {
    if (id) state.activeRequestIds.delete(id);
    state.childOpening = false;
    if (selected === state && childOpenStatus.dataset.state !== "error") {
      childOpenStatus.hidden = true;
    }
  }
}

function returnToTree() {
  returnToView(selected?.returnTree);
}

function returnToView(state) {
  if (!state || !viewSupport(state.descriptor) || !isKnownView(state)) return;
  closeSelectedTable();
  if (state.kind === "tree") {
    selected = state;
    renderViewBreadcrumbs();
    viewer.hidden = true;
    treeViewer.hidden = false;
    treeParentReturn.hidden = state.returnTree === null;
    treeTitleElement.textContent = state.descriptor.title ?? "Untitled object";
    treeMetaElement.textContent = treeDescriptorText(state.descriptor) +
      " · " + state.session;
    renderTreeBreadcrumbs(state);
    loadTreeChildren(state, state.offset);
  } else {
    openView(state.session, state.descriptor, state.returnTree, state);
  }
}

function isActiveView(state) {
  return selected === state && isKnownView(state);
}

function isKnownView(state) {
  const current = knownTables.get(`${state.session}\0${state.descriptor.view}`);
  return current?.descriptor.generation === state.descriptor.generation;
}

function renderViewBreadcrumbs() {
  viewBreadcrumb.replaceChildren();
  childOpenStatus.hidden = true;
  const chain = [];
  for (let state = selected; state; state = state.returnTree) {
    chain.unshift(state);
  }
  chain.forEach((state, depth) => {
    const item = document.createElement("li");
    const label = state.descriptor.title ?? "Untitled view";
    if (state === selected) item.textContent = label;
    else {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.viewDepth = String(depth);
      button.textContent = label;
      button.addEventListener("click", () => returnToView(state));
      item.append(button);
    }
    viewBreadcrumb.append(item);
  });
}

function captureQueryForm() {
  return [
    sortColumn,
    sortDirection,
    filterColumn,
    filterOperator,
    filterValue,
    filterUpper,
  ]
    .map((element) => element.value);
}

function restoreQueryForm(values) {
  [sortColumn.value, sortDirection.value, filterColumn.value] = values;
  updateFilterOperators();
  [filterOperator.value, filterValue.value, filterUpper.value] = values.slice(
    3,
  );
  updateFilterInputs();
}

function populateColumnChoices() {
  if (!selected) return;
  fillColumnSelect(sortColumn, true);
  fillColumnSelect(filterColumn, false);
  sortFieldset.hidden = selected.descriptor.capabilities.sort !== true ||
    !selected.columns.some((schema) => schema.sortable === true);
  filterFieldset.hidden = selected.descriptor.capabilities.filter !== true ||
    selected.columns.length === 0;
  updateFilterOperators();
}

function fillColumnSelect(select, sortableOnly) {
  select.replaceChildren();
  for (const schema of selected.columns) {
    if (sortableOnly && schema.sortable !== true) continue;
    const option = document.createElement("option");
    option.value = String(schema.position);
    option.textContent = `${schema.name ?? ""} · ${
      schema.type ?? "other"
    } (#${schema.position})`;
    select.append(option);
  }
}

function filterOperators(schema) {
  if (!schema) return [];
  if (selected?.descriptor.capabilities.filter !== true) return [];
  const common = [["is_na", "Is missing"]];
  if (schema.filterable !== true) return common;
  if (["string", "categorical"].includes(schema.type)) {
    return common.concat([
      ["contains", "Contains"],
      ["starts_with", "Starts with"],
      ["ends_with", "Ends with"],
      ["text_equals", "Equals text"],
    ]);
  }
  if (
    ["integer", "number", "duration", "date", "datetime"].includes(schema.type)
  ) {
    return common.concat([
      ["eq", "Equals"],
      ["ne", "Does not equal"],
      ["lt", "Less than"],
      ["le", "At most"],
      ["gt", "Greater than"],
      ["ge", "At least"],
      ["between", "Between"],
    ]);
  }
  if (schema.type === "int64") {
    return common.concat([["eq", "Equals"], ["between", "Between"]]);
  }
  if (schema.type === "boolean") {
    return common.concat([["is_true", "Is true"], ["is_false", "Is false"]]);
  }
  return common;
}

function updateFilterOperators() {
  if (!selected) return;
  const schema = selected.columns.find((column) =>
    String(column.position) === filterColumn.value
  );
  filterOperator.replaceChildren();
  for (const [value, label] of filterOperators(schema)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filterOperator.append(option);
  }
  const enabled = filterOperator.options.length > 0;
  filterValue.disabled = !enabled;
  filterUpper.disabled = !enabled;
  $("#filter-apply").disabled = !enabled;
  updateFilterInputs();
}

function updateFilterInputs() {
  const operator = filterOperator.value;
  const schema = selected?.columns.find((column) =>
    String(column.position) === filterColumn.value
  );
  const usesValue = !["is_na", "is_true", "is_false"].includes(operator);
  filterValue.hidden = !usesValue;
  filterUpper.hidden = operator !== "between";
  filterValue.placeholder = valuePlaceholder(schema);
  filterUpper.placeholder = valuePlaceholder(schema, "Upper bound");
  if (schema?.type === "datetime") {
    filterHelp.textContent =
      "Use YYYY-MM-DDTHH:MM:SSZ or an explicit offset such as +05:30. R's local timezone is not inferred by the Snapshot viewer.";
  } else if (schema?.type === "duration") {
    filterHelp.textContent =
      `Use a number in ${schema.units}, or H:MM:SS with an optional fraction and a leading minus sign. Comparisons use the underlying value, not the displayed rounding.`;
  } else if (["string", "categorical"].includes(schema?.type)) {
    filterHelp.textContent =
      "Text comparisons ignore ASCII letter case; non-ASCII case is preserved.";
  } else {
    filterHelp.textContent =
      "Values follow the selected column type. Missing values can be filtered explicitly.";
  }
}

function valuePlaceholder(schema, fallback = "Value") {
  if (schema?.type === "datetime") return "YYYY-MM-DDTHH:MM:SSZ or ±HH:MM";
  if (schema?.type === "date") return "YYYY-MM-DD";
  if (schema?.type === "duration") {
    return `${schema.units}`;
  }
  if (schema?.type === "int64") return "Exact decimal integer";
  return fallback;
}

function addSortTerm() {
  if (!selected) return;
  const position = Number(sortColumn.value);
  const schema = selected.columns.find((column) =>
    column.position === position
  );
  if (
    selected.descriptor.capabilities.sort !== true ||
    !Number.isSafeInteger(position) ||
    schema?.sortable !== true ||
    selected.sort.some((item) => item.col === position)
  ) return;
  if (selected.sort.length >= 16) {
    showNotice("The protocol supports at most 16 sort columns.", "warning");
    return;
  }
  selected.sort.push({ col: position, desc: sortDirection.value === "desc" });
  renderSortTerms();
  reloadFirstPage();
}

function renderSortTerms() {
  sortList.replaceChildren();
  if (!selected) return;
  selected.sort.forEach((term, index) => {
    const schema = selected.columns[term.col];
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${schema?.name ?? ""} (#${term.col}) · ${
      term.desc ? "descending" : "ascending"
    }`;
    const direction = document.createElement("button");
    direction.type = "button";
    direction.textContent = "Reverse";
    direction.addEventListener("click", () => {
      term.desc = !term.desc;
      renderSortTerms();
      reloadFirstPage();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      selected.sort.splice(index, 1);
      renderSortTerms();
      reloadFirstPage();
    });
    item.append(label, direction, remove);
    sortList.append(item);
  });
}

function buildFilterAst() {
  const position = Number(filterColumn.value);
  const schema = selected?.columns.find((column) =>
    column.position === position
  );
  const op = filterOperator.value;
  if (
    selected?.descriptor.capabilities.filter !== true || !schema ||
    (schema.filterable !== true && op !== "is_na")
  ) throw new Error("Choose a filterable column.");
  const node = { op, col: position };
  if (op === "is_na" || op === "is_true" || op === "is_false") return node;
  const value = parseFilterValue(schema, filterValue.value);
  if (op === "between") {
    node.lower = value;
    node.upper = parseFilterValue(schema, filterUpper.value, "Upper bound");
  } else {
    node.value = value;
  }
  return node;
}

function parseFilterValue(schema, value, label = "Value") {
  if (["string", "categorical"].includes(schema.type)) return value;
  if (schema.type === "boolean") {
    throw new Error("Choose a Boolean filter operation.");
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (!value.trim()) throw new Error(`${label} is required.`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} must be a finite number.`);
    }
    if (schema.type === "integer" && !Number.isInteger(parsed)) {
      throw new Error(`${label} must be an integer.`);
    }
    return parsed;
  }
  if (schema.type === "duration") {
    const text = value.trim();
    if (!text) throw new Error(`${label} is required.`);
    if (text.includes(":")) {
      if (!/^-?\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
        throw new Error(`${label} must use H:MM:SS or a number.`);
      }
      return text;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} must use H:MM:SS or a number.`);
    }
    return parsed;
  }
  if (schema.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${label} must use YYYY-MM-DD.`);
    }
    return value;
  }
  if (schema.type === "datetime") {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value)
    ) {
      throw new Error(
        `${label} must include Z or an explicit timezone offset.`,
      );
    }
    return value;
  }
  if (schema.type === "int64") {
    if (!/^(?:0|-?[1-9]\d*)$/.test(value)) {
      throw new Error(`${label} must be a canonical decimal integer.`);
    }
    return value;
  }
  throw new Error(
    `Filtering is not available for ${schema.type ?? "this"} column.`,
  );
}

function applyFilter() {
  if (!selected) return;
  try {
    selected.filter = buildFilterAst();
    showNotice("", "info");
    reloadFirstPage();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function clearFilter() {
  if (!selected) return;
  selected.filter = null;
  filterValue.value = "";
  filterUpper.value = "";
  showNotice("", "info");
  reloadFirstPage();
}

function reloadFirstPage() {
  if (!selected?.table) return;
  selected.epoch++;
  cancelQueryRequests(selected);
  const currentPage = selected.table.getPage();
  const reload = currentPage === 1
    ? selected.table.setData()
    : selected.table.setPage(1);
  reload.catch((error) => showTableError(error));
}

function calculateColumnWindow() {
  const window = columnWindow(
    selected?.columns.length ?? 0,
    viewport.scrollLeft,
    viewport.clientWidth || 720,
    {
      columnWidth: COLUMN_WIDTH,
      overscan: 2,
      maxColumns: 256,
      leadingWidth: ROW_WIDTH,
    },
  );
  return window;
}

function columnScrollExtent(totalWidth) {
  const viewportWidth = viewport.clientWidth || 720;
  const maximumScroll = Math.max(0, totalWidth - viewportWidth);
  const alignedMaximum = Math.ceil(maximumScroll / COLUMN_WIDTH) *
    COLUMN_WIDTH;
  return Math.max(totalWidth, viewportWidth + alignedMaximum);
}

function updateColumnScrollExtent() {
  if (selected?.kind !== "grid" || !selected.window) return;
  spacer.style.width = `${columnScrollExtent(selected.window.totalWidth)}px`;
  scheduleColumnWindow();
}

function scheduleColumnWindow() {
  if (selected?.kind !== "grid" || !selected.window) return;
  if (nextWindowFrame === 0) {
    nextWindowFrame = requestAnimationFrame(() => {
      nextWindowFrame = 0;
      if (!selected) return;
      updateRowColumnCompensation();
      updateColumnWindow();
    });
  }
  clearTimeout(nextWindowTimer);
  nextWindowTimer = setTimeout(requestColumnWindowPage, 80);
}

function cancelColumnWindowUpdate() {
  if (nextWindowFrame !== 0) cancelAnimationFrame(nextWindowFrame);
  nextWindowFrame = 0;
  clearTimeout(nextWindowTimer);
  nextWindowTimer = undefined;
  pendingColumnQuery = false;
}

function updateRowColumnCompensation() {
  const offset = selected?.window?.offsetPx ?? 0;
  const compensation = Math.max(0, viewport.scrollLeft - offset);
  windowElement.style.setProperty(
    "--row-horizontal-compensation",
    `${compensation}px`,
  );
}

function updateColumnWindow() {
  if (selected?.kind !== "grid" || !selected.table || !selected.window) {
    return;
  }
  const next = calculateColumnWindow();
  if (
    next.start === selected.window.start && next.end === selected.window.end
  ) return;
  const state = selected;
  state.window = next;
  state.epoch++;
  updateRowColumnCompensation();
  cancelQueryRequests(state);
  spacer.style.width = `${columnScrollExtent(next.totalWidth)}px`;
  windowElement.style.transform = `translateX(${next.offsetPx}px)`;
  windowElement.style.width = `${
    ROW_WIDTH + next.columns.length * COLUMN_WIDTH
  }px`;
  windowElement.classList.add("is-loading-window");
  state.table.setColumns(buildTableColumns(next.columns));
  pendingColumnQuery = true;
  if (nextWindowTimer === undefined) {
    nextWindowTimer = setTimeout(requestColumnWindowPage, 80);
  }
}

function requestColumnWindowPage() {
  nextWindowTimer = undefined;
  if (selected?.kind !== "grid" || !selected.window) return;
  spacer.style.width = `${columnScrollExtent(selected.window.totalWidth)}px`;
  const maximumScroll = Math.max(
    0,
    viewport.scrollWidth - viewport.clientWidth,
  );
  const nearRightEdge = maximumScroll - viewport.scrollLeft <= COLUMN_WIDTH;
  const alignedScrollLeft = nearRightEdge
    ? maximumScroll
    : Math.floor(viewport.scrollLeft / COLUMN_WIDTH) * COLUMN_WIDTH;
  if (alignedScrollLeft !== viewport.scrollLeft) {
    viewport.scrollLeft = alignedScrollLeft;
    updateRowColumnCompensation();
    return;
  }
  if (!pendingColumnQuery || !selected.table) return;
  pendingColumnQuery = false;
  selected.table.setPage(selected.page).catch((error) => showTableError(error));
}

function buildTableColumns(positions) {
  const state = selected;
  const columns = [{
    title: "Row",
    field: "source_row",
    width: 86,
    minWidth: 86,
    maxWidth: 86,
    headerSort: false,
    resizable: false,
    formatter: (cell) => textNode(Number(cell.getValue()) + 1),
  }];
  for (const position of positions) {
    const schema = selected.columns[position];
    if (!schema) continue;
    columns.push({
      title: "",
      titleFormatter: () => textNode(schema.name ?? ""),
      field: `c${schema.position}`,
      width: COLUMN_WIDTH,
      minWidth: COLUMN_WIDTH,
      maxWidth: COLUMN_WIDTH,
      headerSort: false,
      resizable: false,
      tooltip: false,
      formatter: state.kind === "sequential" &&
          selected.descriptor.encoding === "arrow-ipc" &&
          !schema.unsupported && schema.ipc_index !== null &&
          schema.ipc_index !== undefined
        ? (cell) => arrowCellFormatter(cell, schema, state)
        : schema.drillable === true &&
            selected.descriptor.capabilities.children === true
        ? (cell) => cellFormatter(cell, schema, state)
        : textFormatter,
    });
  }
  return columns;
}

function cellFormatter(cell, schema, state) {
  const content = textNode(cell.getValue() ?? "");
  const rowIndex = cell.getRow().getData().source_row;
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return content;
  content.className = "drillable-cell";
  const open = document.createElement("button");
  open.type = "button";
  open.dataset.action = "open-cell";
  open.dataset.rowIndex = String(rowIndex);
  open.dataset.column = String(schema.position);
  open.textContent = "Open";
  open.setAttribute(
    "aria-label",
    `Open row ${rowIndex + 1}, column ${schema.position}`,
  );
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    openChild(state, [{
      kind: "cell",
      source_row: rowIndex,
      column: schema.position,
    }]);
  });
  content.append(open);
  return content;
}

function arrowCellFormatter(cell, schema, state) {
  const content = textNode(cell.getValue() ?? "");
  const rowIndex = cell.getRow().getData().source_row;
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return content;
  content.className = "drillable-cell";
  const inspect = document.createElement("button");
  inspect.type = "button";
  inspect.dataset.action = "inspect-arrow-cell";
  inspect.dataset.rowIndex = String(rowIndex);
  inspect.dataset.column = String(schema.position ?? schema.index);
  inspect.textContent = "Inspect";
  inspect.setAttribute(
    "aria-label",
    `Inspect row ${rowIndex + 1}, column ${schema.position ?? schema.index}`,
  );
  inspect.addEventListener("click", (event) => {
    event.stopPropagation();
    inspectArrowCell(state, rowIndex, schema.position ?? schema.index);
  });
  content.append(inspect);
  return content;
}

function textFormatter(cell) {
  return textNode(cell.getValue() ?? "");
}

function textNode(value) {
  const span = document.createElement("span");
  span.textContent = String(value);
  return span;
}

async function requestRows(params) {
  const state = selected;
  if (!state) throw new Error("No table is selected.");
  const pageNumber = Number.isSafeInteger(params.page) && params.page > 0
    ? params.page
    : 1;
  state.page = pageNumber;
  const pageSize = Number.isSafeInteger(params.size) && params.size > 0
    ? params.size
    : PAGE_SIZE;
  const offset = (pageNumber - 1) * pageSize;
  const epoch = ++state.epoch;
  cancelQueryRequests(state);
  const sort = state.sort.map(({ col, desc }) => ({ col, desc }));
  const filter = state.filter;
  const cols = state.window.columns;
  setStatus("Loading rows…", "loading");
  windowElement.classList.add("is-loading-window");
  try {
    let result;
    if (state.descriptor.access === "snapshot") {
      const page = querySnapshot(state.descriptor, {
        sort,
        filter,
        offset,
        limit: pageSize,
        cols,
      });
      const schemas = page.data.columns.map((column) => column.schema);
      const data = page.data.columns.map((column) => column.data);
      result = {
        total: page.total,
        total_unfiltered: page.total_unfiltered,
        rows: decodeRows(
          schemas,
          data,
          page.data.source_row,
          page.data.row_labels,
        ),
        warnings: page.warnings ?? [],
      };
    } else if (state.descriptor.access === "random") {
      result = await requestPagedRows(state, {
        epoch,
        offset,
        limit: pageSize,
        sort,
        filter,
        cols,
      });
    } else {
      throw new Error("This view access method is not supported.");
    }
    if (!isCurrent(state, epoch)) throw abortError("The query was replaced.");
    setTableMeta(state, result.total, result.total_unfiltered);
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    windowElement.classList.remove("is-loading-window");
    setStatus("Connected.", "connected");
    showWarnings(result.warnings ?? []);
    return { last_page: lastPage, last_row: result.total, data: result.rows };
  } catch (error) {
    if (!isCurrent(state, epoch) || error?.name === "AbortError") throw error;
    windowElement.classList.remove("is-loading-window");
    showTableError(error);
    throw error;
  }
}

async function requestPagedRows(state, query) {
  return await fillRemotePage({
    offset: query.offset,
    limit: query.limit,
    fetchPage: ({ offset, limit }) =>
      sendPagedRequest(state, {
        view: state.descriptor.view,
        generation: state.descriptor.generation,
        offset,
        limit,
        sort: query.sort,
        filter: query.filter,
        cols: query.cols,
      }),
    decode: (result) => {
      const schemas = result.data.columns.map((column) => column.schema);
      const data = result.data.columns.map((column) => column.data);
      return decodeRows(
        schemas,
        data,
        result.data.source_row,
        result.data.row_labels,
      );
    },
    isCurrent: () => isCurrent(state, query.epoch),
  });
}

function sendPagedRequest(state, params) {
  const promise = transport.request(
    state.session,
    "grid/rows",
    params,
    60_000,
  );
  const id = promise.id;
  if (id) {
    state.activeRequestIds.add(id);
    state.queryRequestIds.add(id);
  }
  return promise.finally(() => {
    if (id) {
      state.activeRequestIds.delete(id);
      state.queryRequestIds.delete(id);
    }
  });
}

function isCurrent(state, epoch) {
  return selected === state && state.epoch === epoch;
}

function showWarnings(warnings) {
  warningsElement.replaceChildren();
  const messages = Array.isArray(warnings) ? warnings : [];
  for (const warning of messages) {
    const item = document.createElement("li");
    item.textContent = String(warning);
    warningsElement.append(item);
  }
  if (messages.length) {
    setStatus(`${messages.length} Producer warning(s).`, "warning");
  }
}

function showTableError(error) {
  if (error?.name === "AbortError") return;
  showNotice(
    error?.code
      ? `${error.code}: ${error.message}`
      : error?.message ?? String(error),
    "error",
  );
  setStatus("The table request failed.", "error");
}

function showNotice(message, state) {
  warningsElement.replaceChildren();
  if (!message) return;
  const item = document.createElement("li");
  item.textContent = message;
  item.dataset.state = state;
  warningsElement.append(item);
}

function abortError(message) {
  return new DOMException(message, "AbortError");
}

function sequentialRecord(state) {
  const record = knownTables.get(`${state.session}\0${state.descriptor.view}`);
  if (!record || record.descriptor.generation !== state.descriptor.generation) {
    throw abortError("The stream generation was closed.");
  }
  record.cacheUse = ++cacheUseClock;
  return record;
}

function openSequential(session, descriptor, returnTree) {
  closeSelectedTable();
  const state = {
    kind: "sequential",
    session,
    descriptor,
    columns: descriptor.columns,
    epoch: 0,
    activeRequestIds: new Set(),
    queryRequestIds: new Set(),
    returnTree,
    table: null,
    cache: sequentialRecord({ session, descriptor }).cache,
    loading: false,
    cacheEnabled: streamCacheCapability !== null,
  };
  selected = state;
  renderViewBreadcrumbs();
  viewer.hidden = false;
  treeViewer.hidden = true;
  treeReturn.hidden = returnTree === null;
  treeParentReturn.hidden = true;
  titleElement.textContent = descriptor.title ?? "Untitled stream";
  warningsElement.replaceChildren();
  paginationElement.replaceChildren();
  $(".query-tools").hidden = true;
  sequentialControls.hidden = false;
  viewport.scrollLeft = 0;
  spacer.style.width = `${ROW_WIDTH + state.columns.length * COLUMN_WIDTH}px`;
  windowElement.style.transform = "";
  windowElement.style.width = "100%";
  windowElement.style.setProperty("--row-horizontal-compensation", "0px");
  state.table = new globalThis.Tabulator(windowElement, {
    height: "460px",
    layout: "fitData",
    index: "source_row",
    data: state.cache.rows(),
    columnDefaults: { width: COLUMN_WIDTH, resizable: false },
    columns: buildTableColumns(state.columns.map((_, i) => i)),
    placeholder: state.cacheEnabled
      ? "Load cached rows or continue the stream."
      : "Load the next rows. Previously consumed rows cannot be fetched again.",
  });
  updateSequentialProgress(state);
  setStatus(
    "Sequential stream ready. Load pages to continue.",
    "connected",
  );
  if (state.cacheEnabled) {
    refreshHostCache(state, true).catch((error) => {
      if (selected === state && error?.name !== "AbortError") {
        sequentialNotice.textContent =
          `Could not restore host-cached pages: ${error.message}`;
      }
    });
  }
}

function updateSequentialProgress(state) {
  const record = sequentialRecord(state);
  const progress = record.progress;
  metaElement.textContent = `${
    progress.rows_seen ?? progress.received
  } rows seen · total unknown · sequential · ${state.session}`;
  sequentialProgress.textContent = `${
    progress.rows_seen ?? progress.received
  } rows seen; ${progress.watermark} rows advanced${
    progress.done ? "; end of stream" : "; total unknown"
  }.`;
  const ids = state.cache.pageIds();
  const cachedNext = ids.length > 0 &&
    (progress.last_page ?? -1) > ids.at(-1);
  sequentialNext.disabled = state.loading || (progress.done && !cachedNext);
  sequentialNext.textContent = state.loading
    ? "Loading…"
    : progress.done && !cachedNext
    ? "End of stream"
    : "Load next";
  const notices = [];
  const prefixGap = record.cacheInfo?.unavailable_before ?? 0;
  if (state.cacheEnabled) {
    const gaps = [];
    if (prefixGap > 0) gaps.push([0, prefixGap]);
    for (const page of record.cachePages.values()) {
      if (page.unavailable_before_range) {
        gaps.push(page.unavailable_before_range);
      }
    }
    if (
      progress.gap &&
      !gaps.some(([start, end]) =>
        start === progress.gap[0] && end === progress.gap[1]
      )
    ) gaps.push(progress.gap);
    notices.push(...formatUnavailableRowRanges(gaps));
  } else if (progress.gap) {
    notices.push(
      `${progress.gap[0]}–${progress.gap[1]} rows advanced but not displayed.`,
    );
  }
  if (state.cache.evictedThrough >= 0) {
    notices.push(
      state.cacheEnabled
        ? `Older rows were evicted from this browser's display cache; load earlier cached rows to retrieve any pages the host still retains.`
        : `Rows through ${
          state.cache.evictedThrough + 1
        } were evicted from this browser's display cache.`,
    );
  }
  sequentialNotice.textContent = notices.join(" ");
  sequentialEarlier.hidden = !state.cacheEnabled || !hasEarlierHostPages(state);
  sequentialEarlier.disabled = state.loading;
}

function requestCacheInfo(state, afterPage, limit = 32) {
  const params = {
    view: state.descriptor.view,
    generation: state.descriptor.generation,
    limit,
  };
  if (afterPage !== null && afterPage >= 0) params.after_page = afterPage;
  return cacheRequest(state, "stream/cache/info", params, 30_000)
    .then((response) => {
      const info = response?.result;
      if (
        !info || info.view !== state.descriptor.view ||
        info.generation !== state.descriptor.generation ||
        !Array.isArray(info.pages) ||
        !Number.isSafeInteger(info.last_page) || info.last_page < -1 ||
        !Number.isSafeInteger(info.rows_seen) || info.rows_seen < 0 ||
        typeof info.done !== "boolean" ||
        (info.next_after !== null &&
          (!Number.isSafeInteger(info.next_after) || info.next_after < 0)) ||
        (info.unavailable_before !== undefined &&
          (!Number.isSafeInteger(info.unavailable_before) ||
            info.unavailable_before < 0)) ||
        info.pages.length > limit ||
        !info.pages.every((page, index) =>
          validCachePageMetadata(page) && page.page <= info.last_page &&
          (index === 0 || page.page > info.pages[index - 1].page)
        )
      ) throw new Error("The host returned an invalid stream cache catalog.");
      return info;
    });
}

function validCachePageMetadata(page) {
  return page && typeof page === "object" &&
    Number.isSafeInteger(page.page) && page.page >= 0 &&
    Number.isSafeInteger(page.first_row) && page.first_row >= 0 &&
    Number.isSafeInteger(page.rows_fetched) && page.rows_fetched >= 0 &&
    page.rows_seen === page.first_row + page.rows_fetched &&
    Number.isSafeInteger(page.byte_length) && page.byte_length >= 0 &&
    typeof page.done === "boolean" &&
    (page.unavailable_before_range === undefined ||
      (Array.isArray(page.unavailable_before_range) &&
        page.unavailable_before_range.length === 2 &&
        page.unavailable_before_range.every((n) =>
          Number.isSafeInteger(n) && n >= 0
        ) &&
        page.unavailable_before_range[0] <=
          page.unavailable_before_range[1]));
}

function cacheRequest(state, method, params, timeout) {
  const promise = transport.request(state.session, method, params, timeout);
  if (promise.id) state.activeRequestIds.add(promise.id);
  return promise.finally(() => {
    if (promise.id) state.activeRequestIds.delete(promise.id);
  });
}

function mergeCacheInfo(record, info) {
  const old = record.cacheInfo ?? {};
  record.cacheInfo = mergeSequentialCacheInfo(old, info);
  if (info.last_page >= (record.progress.last_page ?? -1)) {
    record.progress.last_page = info.last_page;
    record.progress.rows_seen = info.rows_seen;
    record.progress.watermark = Math.max(
      record.progress.watermark,
      info.rows_seen,
    );
    record.progress.done = info.done;
  }
  for (const page of info.pages) {
    record.cachePages.set(page.page, page);
    if (page.unavailable_before_range) {
      record.progress.gap = page.unavailable_before_range;
    }
  }
  record.cacheCatalogCursor = info.next_after;
  pruneCacheCatalog(record);
}

function pruneCacheCatalog(record) {
  const keep = new Set(record.cache?.pageIds() ?? []);
  if (Number.isSafeInteger(record.earliestHostPage)) {
    for (const page of record.cachePages.keys()) {
      if (page < record.earliestHostPage && !keep.has(page)) {
        record.cachePages.delete(page);
      }
    }
  }
  const newest = [...record.cachePages.keys()].sort((a, b) => b - a);
  for (const page of newest) {
    if (keep.size >= 256) break;
    keep.add(page);
  }
  for (const page of record.cachePages.keys()) {
    if (!keep.has(page)) record.cachePages.delete(page);
  }
}

async function refreshHostCache(state, hydrate) {
  if (!state.cacheEnabled) return;
  const record = sequentialRecord(state);
  const tail = await requestCacheInfo(state, Number.MAX_SAFE_INTEGER, 1);
  if (selected !== state) return;
  mergeCacheInfo(record, tail);
  const earliest = await requestCacheInfo(state, null, 1);
  if (selected !== state) return;
  if (earliest.pages.length) {
    record.earliestHostPage = earliest.pages[0].page;
    mergeCacheInfo(record, earliest);
    pruneCacheCatalog(record);
  } else {
    record.earliestHostPage = null;
  }
  if (tail.last_page >= 0) {
    const after = Math.max(-1, tail.last_page - SEQUENTIAL_CACHE_PAGES);
    const window = await requestCacheInfo(state, after, SEQUENTIAL_CACHE_PAGES);
    if (selected !== state) return;
    mergeCacheInfo(record, window);
    if (hydrate) await restoreHostPages(state, window.pages);
  }
  if (selected === state && isKnownView(state)) {
    updateSequentialProgress(state);
  }
}

async function restoreHostPages(state, pages) {
  if (!Array.isArray(pages) || pages.length > SEQUENTIAL_CACHE_PAGES) {
    throw new Error("The host cache page request exceeded its bound.");
  }
  const record = sequentialRecord(state);
  for (const metadata of pages) {
    if (selected !== state) return;
    if (!validCachePageMetadata(metadata)) {
      throw new Error("The host returned an invalid cached page index.");
    }
    if (record.cache.hasPage(metadata.page)) continue;
    const response = await cacheRequest(
      state,
      "stream/cache/get",
      {
        view: state.descriptor.view,
        generation: state.descriptor.generation,
        page: metadata.page,
        max_bytes: 4 * 1024 * 1024,
      },
      30_000,
    );
    if (selected !== state) return;
    const result = response?.result;
    const page = result?.cache_page;
    if (
      !response.binary || !page || page.page !== metadata.page ||
      result.view !== state.descriptor.view ||
      result.generation !== state.descriptor.generation ||
      result.first_row !== page.first_row ||
      result.rows_fetched !== page.rows_fetched ||
      result.rows_seen !== page.rows_seen || result.done !== page.done ||
      !validCachePageMetadata(page) ||
      result.transfer?.encoding !== "arrow-ipc" ||
      result.transfer.byte_length !== response.binary.byteLength ||
      page.byte_length !== response.binary.byteLength
    ) throw new Error("The host returned an invalid cached page.");
    const decoded = decodeArrowPage(
      response.binary,
      state.descriptor,
      result,
    );
    retainArrowPage(record, response.binary, result);
    record.cache.discard(decoded.discardedThrough);
    record.cache.setPage(page.page, decoded.rows);
    record.cachePages.set(page.page, page);
    pruneCacheCatalog(record);
    record.cacheUse = ++cacheUseClock;
    trimBrowserCaches(state);
  }
  if (selected === state && state.table) {
    await state.table.setData(record.cache.rows());
    updateSequentialProgress(state);
  }
}

function trimBrowserCaches(activeState) {
  const records = [...knownTables.values()].filter((record) => record.cache);
  trimSequentialCaches(records, SEQUENTIAL_TOTAL_CACHE_BYTES);
  if (selected === activeState && activeState.table) {
    activeState.table.setData(activeState.cache.rows());
  }
}

function hasEarlierHostPages(state) {
  const record = sequentialRecord(state);
  const ids = record.cache.pageIds();
  return ids.length > 0 && Number.isSafeInteger(record.earliestHostPage) &&
    ids[0] > record.earliestHostPage;
}

async function loadEarlierCachedPages(state) {
  if (selected !== state || state.loading || !state.cacheEnabled) return;
  const record = sequentialRecord(state);
  const epoch = state.epoch;
  const minimum = state.cache.pageIds()[0];
  if (!Number.isSafeInteger(minimum)) return;
  state.loading = true;
  updateSequentialProgress(state);
  try {
    const info = await requestCacheInfo(
      state,
      Math.max(-1, minimum - SEQUENTIAL_CACHE_PAGES - 1),
      SEQUENTIAL_CACHE_PAGES,
    );
    if (!isCurrent(state, epoch)) return;
    mergeCacheInfo(record, info);
    const pages = info.pages.filter((page) => page.page < minimum);
    if (pages.length) {
      record.cache.clear();
      await restoreHostPages(state, pages);
    } else updateSequentialProgress(state);
  } catch (error) {
    if (selected === state && error?.code === "unavailable") {
      await refreshHostCache(state, true);
    } else if (selected === state) {
      showTableError(error);
    }
  } finally {
    state.loading = false;
    if (selected === state && isKnownView(state)) {
      updateSequentialProgress(state);
    }
  }
}

async function loadSequentialPage(state) {
  const record = sequentialRecord(state);
  const epoch = state.epoch;
  const ids = state.cache.pageIds();
  const nextPage = ids.length === 0 ? 0 : ids.at(-1) + 1;
  if (selected !== state || state.loading) {
    return;
  }
  if (state.cacheEnabled && record.cachePages.has(nextPage)) {
    state.loading = true;
    updateSequentialProgress(state);
    try {
      await restoreHostPages(state, [record.cachePages.get(nextPage)]);
    } catch (error) {
      if (error?.code === "unavailable") {
        record.cachePages.delete(nextPage);
        await refreshHostCache(state, true);
      } else if (selected === state) showTableError(error);
    } finally {
      state.loading = false;
      if (selected === state && isKnownView(state)) {
        updateSequentialProgress(state);
      }
    }
    return;
  }
  if (state.cacheEnabled) {
    state.loading = true;
    updateSequentialProgress(state);
    try {
      const info = await requestCacheInfo(state, Number.MAX_SAFE_INTEGER, 1);
      if (!isCurrent(state, epoch)) return;
      mergeCacheInfo(record, info);
      if (info.last_page >= nextPage) {
        const pages = await requestCacheInfo(
          state,
          nextPage - 1,
          32,
        );
        if (!isCurrent(state, epoch)) return;
        mergeCacheInfo(record, pages);
        const metadata = pages.pages.find((page) => page.page === nextPage);
        if (metadata) {
          await restoreHostPages(state, [metadata]);
          return;
        }
        // A retained-page race is retried from a fresh catalog, never by consuming another producer page.
        record.cachePages.delete(nextPage);
        await refreshHostCache(state, true);
        if (!isCurrent(state, epoch)) return;
        if (record.cachePages.has(nextPage)) {
          await restoreHostPages(state, [record.cachePages.get(nextPage)]);
        }
        return;
      }
      if (record.progress.done) return;
    } catch (error) {
      if (selected === state) showTableError(error);
      return;
    } finally {
      state.loading = false;
      if (selected === state && isKnownView(state)) {
        updateSequentialProgress(state);
      }
    }
  }
  if (!isCurrent(state, epoch)) return;
  state.loading = true;
  updateSequentialProgress(state);
  const maxRows = sequentialPageRows(state.descriptor, PAGE_SIZE);
  const params = {
    view: state.descriptor.view,
    generation: state.descriptor.generation,
    max_rows: maxRows,
    max_bytes: 4 * 1024 * 1024,
  };
  if (state.cacheEnabled) params.after_page = record.progress.last_page ?? -1;
  const promise = transport.request(
    state.session,
    "stream/next",
    params,
    60_000,
  );
  if (promise.id) state.activeRequestIds.add(promise.id);
  try {
    const response = await promise;
    if (!isCurrent(state, epoch)) return;
    const metadata = response.result;
    if (
      !metadata || metadata.view !== state.descriptor.view ||
      metadata.generation !== state.descriptor.generation ||
      !Number.isSafeInteger(metadata.rows_fetched) ||
      metadata.rows_fetched < 0 || metadata.rows_fetched > maxRows ||
      !response.binary
    ) throw new Error("The producer returned an invalid sequential page.");
    const progress = sequentialRecord(state).progress;
    const nextProgress = { ...progress };
    recordSequentialProgress(nextProgress, metadata);
    const decoded = decodeArrowPage(
      response.binary,
      state.descriptor,
      metadata,
    );
    Object.assign(progress, nextProgress);
    progress.rows_seen = metadata.rows_seen;
    state.cache.discard(decoded.discardedThrough);
    const page = state.cacheEnabled ? metadata.cache_page?.page : nextPage;
    if (state.cacheEnabled && (!Number.isSafeInteger(page) || page < 0)) {
      throw new Error("The host omitted the sequential cache page index.");
    }
    retainArrowPage(sequentialRecord(state), response.binary, {
      ...metadata,
      page,
    });
    state.cache.setPage(page, decoded.rows);
    if (state.cacheEnabled) {
      sequentialRecord(state).cachePages.set(page, metadata.cache_page);
      pruneCacheCatalog(sequentialRecord(state));
      progress.last_page = page;
      progress.unavailable_before =
        metadata.cache_page.unavailable_before_range?.[1] ??
          progress.unavailable_before ?? 0;
    }
    trimBrowserCaches(state);
    await state.table.setData(state.cache.rows());
    if (state.cacheEnabled) {
      await refreshEarliestHostPage(state, epoch);
    }
    showWarnings(response.warnings ?? []);
    setStatus(
      metadata.done ? "End of stream." : "Connected. Load next to continue.",
      "connected",
    );
  } catch (error) {
    if (state.cacheEnabled && error?.code === "cache_changed") {
      try {
        await refreshHostCache(state, true);
      } catch (refreshError) {
        if (selected === state) showTableError(refreshError);
      }
      return;
    }
    if (state.cacheEnabled && error?.code === "unavailable") {
      try {
        await refreshHostCache(state, true);
      } catch (refreshError) {
        if (selected === state) showTableError(refreshError);
      }
      return;
    }
    if (selected === state && error?.name !== "AbortError") {
      showTableError(error);
    }
  } finally {
    if (promise.id) state.activeRequestIds.delete(promise.id);
    state.loading = false;
    if (selected === state && isKnownView(state)) {
      updateSequentialProgress(state);
    }
  }
}

async function refreshEarliestHostPage(state, epoch) {
  const info = await requestCacheInfo(state, null, 1);
  if (!isCurrent(state, epoch)) return;
  const record = sequentialRecord(state);
  record.earliestHostPage = info.pages[0]?.page ?? null;
  mergeCacheInfo(record, info);
  updateSequentialProgress(state);
}

// Shared row parts for the Object Tree and the Resource Tree explorer.
function summaryElement(child) {
  const summary = document.createElement("span");
  summary.className = "muted tree-summary";
  summary.textContent = rowSummaryText(child);
  return summary;
}

function unavailableElement(token) {
  const unavailable = document.createElement("span");
  unavailable.className = "tree-unavailable";
  unavailable.textContent = "Unavailable: " + token;
  return unavailable;
}

const KIND_GLYPHS = {
  container: "▣",
  table: "▦",
  object: "{ }",
  value: "•",
  function: "ƒ",
  unknown: "?",
};

// Creates the explorer of a session that declared resources and fetches its
// root listing. Sessions without the capability get nothing. A session that
// also declared `resource_changes` is subscribed first, so that no change
// between the first listing and the subscription can be missed.
function ensureExplorer(session) {
  const info = knownSessions.get(session);
  if (!info || !declaresResources(info) || explorers.has(session)) return;
  const element = document.createElement("article");
  element.className = "resource-explorer";
  element.dataset.session = session;
  const entry = {
    explorer: createExplorer(),
    element,
    status: null,
    statusElement: null,
    detailElement: null,
    bodyElement: null,
  };
  buildExplorerFrame(session, entry);
  explorers.set(session, entry);
  resourcesElement.append(element);
  syncResourcesPanel();
  if (info.capabilities?.resource_changes === true) {
    void subscribeThenLoad(session, entry);
  } else loadResources(session, entry.explorer.root, 0);
}

async function subscribeThenLoad(session, entry) {
  try {
    await transport.request(
      session,
      "resources/subscribe",
      { enabled: true },
      60_000,
    );
  } catch (error) {
    if (error?.name === "AbortError") return;
    // The listing and the manual Refresh still work; the subscription is not
    // tried again.
    if (explorers.get(session) === entry) {
      entry.detailElement.textContent =
        `${session} · Automatic updates are unavailable`;
    }
  }
  if (explorers.get(session) !== entry) return;
  loadResources(session, entry.explorer.root, 0);
}

// A change notice only raises a flag; `refreshWhenDue` decides when to fetch.
function resourcesChanged(session) {
  const entry = explorers.get(session);
  if (!entry) return;
  markChanged(entry.explorer);
  refreshWhenDue(session);
}

// Starts the refresh that a pending change notice asks for. It waits while a
// fetch is in flight (the caller checks again when that fetch completes) and
// while the explorer is out of sight (the panel is folded on a narrow screen).
function refreshWhenDue(session) {
  const entry = explorers.get(session);
  if (!entry || !refreshDue(entry.explorer)) return;
  if (!wideScreen.matches && !resourcesPanel.open) return;
  refreshResources(session);
}

resourcesPanel.addEventListener("toggle", () => {
  if (!resourcesPanel.open) return;
  for (const session of [...explorers.keys()]) refreshWhenDue(session);
});

function disposeExplorer(session) {
  const entry = explorers.get(session);
  if (!entry) return;
  closeExplorer(entry.explorer);
  entry.element.remove();
  explorers.delete(session);
  syncResourcesPanel();
}

// The explorer lives in a sidebar next to the viewer on wide screens and in a
// collapsible, height-limited panel above it on narrow ones. Without any
// explorer the panel is hidden and the layout is a single column.
function syncResourcesPanel() {
  const present = explorers.size > 0;
  resourcesPanel.hidden = !present;
  workspace.classList.toggle("has-sidebar", present);
}

// The sidebar cannot be collapsed, so a panel that was folded while the window
// was narrow opens again when the window becomes wide.
const wideScreen = globalThis.matchMedia("(min-width: 56.25rem)");
wideScreen.addEventListener("change", () => {
  if (wideScreen.matches) resourcesPanel.open = true;
});

function cancelResourceRequests(ids) {
  for (const id of ids) {
    if (id) {
      transport.cancel(id, "A newer Resource Tree request replaced this one.");
    }
  }
}

function loadResources(session, node, offset, options = {}) {
  const entry = explorers.get(session);
  if (!entry) return;
  const { explorer } = entry;
  const token = startLoad(explorer, node, offset, options);
  if (!token) return;
  cancelResourceRequests([token.cancelId]);
  const promise = transport.request(
    session,
    "resources/children",
    { node: nodeIdOf(node), offset, limit: RESOURCE_PAGE_SIZE },
    60_000,
  );
  node.requestId = promise.id ?? null;
  renderExplorer(session);
  promise.then((response) => {
    if (!isResourceFetchCurrent(explorer, node, token)) return;
    const { cancelIds, continueAt } = finishLoad(
      explorer,
      node,
      token,
      response?.result,
    );
    cancelResourceRequests(cancelIds);
    // A refresh reads a node's pages again until it has covered what was
    // loaded before; the listing on screen is replaced only at the end.
    if (continueAt !== null) loadResources(session, node, continueAt);
    else {
      renderExplorer(session);
      refreshWhenDue(session);
    }
  }).catch((error) => {
    if (error?.name === "AbortError") return;
    const message = error?.code
      ? error.code + ": " + error.message
      : error?.message ?? String(error);
    if (failLoad(explorer, node, token, message)) renderExplorer(session);
  });
}

function toggleResourceNode(session, parent, child) {
  const entry = explorers.get(session);
  if (!entry) return;
  const node = nodeFor(entry.explorer, childPath(parent, child.id), child);
  if (node.expanded) {
    cancelResourceRequests([collapse(node)]);
    renderExplorer(session);
    refreshWhenDue(session);
  } else if (expand(entry.explorer, node)) {
    loadResources(session, node, 0);
  } else renderExplorer(session);
}

function refreshResources(session) {
  const entry = explorers.get(session);
  if (!entry) return;
  const { targets, cancelIds } = refreshAll(entry.explorer);
  cancelResourceRequests(cancelIds);
  for (const node of targets) {
    loadResources(session, node, 0, { refresh: true });
  }
  renderExplorer(session);
}

async function openResource(session, child) {
  const entry = explorers.get(session);
  if (!entry || !beginOpen(entry.explorer, child.id)) return;
  const { explorer } = entry;
  entry.status = { state: "waiting", text: "Opening the resource…" };
  renderExplorer(session);
  try {
    // The producer registers the view with a view/open notification before it
    // answers; the answer only identifies the view and never creates one.
    const response = await transport.request(
      session,
      "resources/open",
      { node: child.id },
      60_000,
    );
    if (explorer.closed) return;
    const reply = response?.result;
    if (
      typeof reply?.view !== "string" ||
      !Number.isSafeInteger(reply.generation)
    ) {
      throw new Error("The producer returned an invalid resource view reply.");
    }
    const record = await announcedTable(session, reply.view, reply.generation);
    if (explorer.closed) return;
    const descriptor = record?.descriptor;
    if (!descriptor) throw new Error("The resource view is no longer open.");
    if (!viewSupport(descriptor)) {
      throw new Error("The producer returned an invalid resource view.");
    }
    entry.status = null;
    openView(session, descriptor);
  } catch (error) {
    if (explorer.closed || error?.name === "AbortError") return;
    entry.status = {
      state: "error",
      text: error?.code
        ? error.code + ": " + error.message
        : error?.message ?? String(error),
    };
  } finally {
    endOpen(explorer, child.id);
    if (!explorer.closed) renderExplorer(session);
  }
}

// The heading and controls are built once so that a re-render caused by a
// response never replaces a button under the pointer; only the status line and
// the listing are rebuilt.
function buildExplorerFrame(session, entry) {
  const { explorer, element } = entry;
  const heading = document.createElement("h3");
  heading.textContent = "Resources";
  const detail = document.createElement("p");
  detail.className = "muted";
  detail.textContent = session;
  entry.detailElement = detail;
  const controls = document.createElement("div");
  controls.className = "resource-controls";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.dataset.action = "refresh-resources";
  refresh.dataset.focusKey = "refresh";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", () => refreshResources(session));
  const hiddenLabel = document.createElement("label");
  hiddenLabel.className = "tree-options";
  const hiddenToggle = document.createElement("input");
  hiddenToggle.type = "checkbox";
  hiddenToggle.dataset.action = "toggle-hidden";
  hiddenToggle.dataset.focusKey = "hidden";
  hiddenToggle.addEventListener("change", () => {
    explorer.showHidden = hiddenToggle.checked;
    renderExplorer(session);
  });
  hiddenLabel.append(hiddenToggle, " Show hidden");
  controls.append(refresh, hiddenLabel);
  const status = document.createElement("p");
  status.className = "resource-status";
  status.setAttribute("aria-live", "polite");
  const body = document.createElement("div");
  body.className = "resource-body";
  // The header stays pinned at the top of the scrolling explorer area while
  // the listing below it scrolls.
  const header = document.createElement("div");
  header.className = "resource-header";
  header.append(heading, detail, controls, status);
  element.replaceChildren(header, body);
  entry.statusElement = status;
  entry.bodyElement = body;
}

function renderExplorer(session) {
  const entry = explorers.get(session);
  if (!entry) return;
  const { explorer, element } = entry;
  const focused = element.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey
    : undefined;
  const status = entry.statusElement;
  if (entry.status) {
    status.dataset.state = entry.status.state;
    status.textContent = entry.status.text;
    status.hidden = false;
  } else {
    status.hidden = true;
    status.textContent = "";
    delete status.dataset.state;
  }
  entry.bodyElement.replaceChildren(
    renderResourceBody(session, explorer, explorer.root, []),
  );
  if (focused) {
    for (const target of element.querySelectorAll("[data-focus-key]")) {
      if (target.dataset.focusKey === focused) {
        if (document.activeElement !== target) target.focus();
        break;
      }
    }
  }
}

// Renders the listing of one node: its visible children, then a status line,
// an empty-state note, and the entry to the next page.
function renderResourceBody(session, explorer, node, ancestors) {
  const list = document.createElement("ul");
  list.className = "resource-children";
  const listKey = nodeKey(node);
  const children = visibleChildren(node, explorer.showHidden);
  for (const child of children) {
    const item = document.createElement("li");
    item.className = "resource-node";
    const row = document.createElement("div");
    row.className = "resource-row";
    const label = rowLabel(child);
    const identified = typeof child.id === "string" && child.id.length > 0;
    const expandable = canExpand(child);
    if (expandable) {
      const open = existingChild(explorer, node, child.id)?.expanded === true;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "resource-toggle";
      toggle.dataset.action = "toggle-node";
      toggle.dataset.focusKey = "toggle:" + nodeKey(node) + child.id;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute(
        "aria-label",
        (open ? "Collapse " : "Expand ") + label,
      );
      toggle.textContent = open ? "▾" : "▸";
      toggle.addEventListener(
        "click",
        () => toggleResourceNode(session, node, child),
      );
      row.append(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "resource-toggle";
      row.append(spacer);
    }
    const kind = normalizeKind(child.kind);
    const glyph = document.createElement("span");
    glyph.className = "resource-kind";
    glyph.dataset.kind = kind;
    glyph.title = kind;
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = KIND_GLYPHS[kind];
    const name = document.createElement("span");
    name.className = "resource-label";
    name.textContent = label;
    row.append(glyph, name, summaryElement(child));
    if (typeof child.unavailable === "string") {
      row.append(unavailableElement(child.unavailable));
    } else if (canOpen(child)) {
      const open = document.createElement("button");
      open.type = "button";
      open.dataset.action = "open-resource";
      open.dataset.focusKey = "open:" + child.id;
      open.textContent = "Open";
      open.disabled = explorer.opening.has(child.id);
      open.addEventListener("click", () => openResource(session, child));
      row.append(open);
    }
    item.append(row);
    if (identified && !ancestors.includes(child.id)) {
      const childNode = existingChild(explorer, node, child.id);
      if (expandable && childNode?.expanded) {
        item.append(
          renderResourceBody(session, explorer, childNode, [
            ...ancestors,
            child.id,
          ]),
        );
      }
    }
    list.append(item);
  }

  const notes = [];
  if (node.loading) notes.push(node.loaded ? "Refreshing…" : "Loading…");
  if (node.error) notes.push(node.error);
  if (
    node.loaded && !node.loading && !node.error && children.length === 0 &&
    !hasMore(node)
  ) {
    const hidden = hiddenCount(node);
    notes.push(
      hidden > 0 ? `No visible resources (${hidden} hidden)` : "No resources",
    );
  }
  for (const note of notes) {
    const item = document.createElement("li");
    item.className = "resource-note muted";
    item.textContent = note;
    if (note === node.error) {
      item.dataset.state = "error";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.action = "retry-resources";
      retry.textContent = "Retry";
      retry.addEventListener(
        "click",
        () => loadResources(session, node, node.failedOffset),
      );
      item.append(" ", retry);
    }
    list.append(item);
  }
  if (hasMore(node)) {
    const item = document.createElement("li");
    item.className = "resource-more";
    const more = document.createElement("button");
    more.type = "button";
    more.dataset.action = "load-more";
    more.dataset.focusKey = "more:" + listKey;
    more.textContent = "Load more";
    more.disabled = node.loading;
    more.addEventListener(
      "click",
      () => loadResources(session, node, node.nextOffset),
    );
    item.append(more);
    if (node.total !== null) {
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = ` ${node.children.length} of ${node.total} loaded`;
      item.append(count);
    }
    list.append(item);
  }
  return list;
}
