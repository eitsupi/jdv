// Browser-side state for a session's Resource Tree explorer.
//
// Everything here is DOM-free so the bookkeeping can be unit tested. The
// explorer keeps one node record per node id plus a root record. A record owns
// its listed children, the next offset the producer announced, and a local
// fetch generation. The fetch generation is private to the browser and is not
// a view generation: it only lets the explorer drop responses that a refresh,
// a collapse, or a newer fetch has made obsolete.

export const RESOURCE_PAGE_SIZE = 200;

const KNOWN_KINDS = new Set([
  "container",
  "table",
  "object",
  "value",
  "function",
  "unknown",
]);

/** Returns true when the session hello declared the Resource Tree capability. */
export function declaresResources(helloParams) {
  return helloParams?.capabilities?.resources === true;
}

/** Maps a producer `kind` token to a recommended token; others are unknown. */
export function normalizeKind(kind) {
  return typeof kind === "string" && KNOWN_KINDS.has(kind) ? kind : "unknown";
}

/** Display label shared by the Object Tree and the Resource Tree. */
export function rowLabel(child) {
  return typeof child?.label === "string" ? child.label : "(unnamed)";
}

/** Class names and summary joined for display; empty when there are none. */
export function rowSummaryText(child) {
  const classes = Array.isArray(child?.class)
    ? child.class.filter((value) => typeof value === "string").join(", ")
    : "";
  return [classes, child?.summary]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" · ");
}

function createNode(entry) {
  return {
    entry,
    expanded: false,
    children: [],
    seen: new Set(),
    nextOffset: null,
    total: null,
    loaded: false,
    stale: false,
    loading: false,
    error: null,
    failedOffset: 0,
    generation: 0,
    requestId: null,
  };
}

export function createExplorer() {
  return {
    showHidden: false,
    root: createNode(null),
    nodes: new Map(),
    opening: new Set(),
    closed: false,
  };
}

/** Returns the record of a node id, creating it on first use; null is the root. */
export function nodeFor(explorer, id, entry = null) {
  if (id === null || id === undefined) return explorer.root;
  let node = explorer.nodes.get(id);
  if (!node) {
    node = createNode(entry);
    explorer.nodes.set(id, node);
  } else if (entry) node.entry = entry;
  return node;
}

/** The node id sent in `resources/children`; `null` addresses the root. */
export function nodeIdOf(node) {
  return node.entry?.id ?? null;
}

function hasId(entry) {
  return typeof entry?.id === "string" && entry.id.length > 0;
}

/** Whether the viewer may offer an expand control for the entry. */
export function canExpand(entry) {
  return entry?.has_children === true && hasId(entry) &&
    typeof entry.unavailable !== "string";
}

/** Whether the viewer may offer an Open control for the entry. */
export function canOpen(entry) {
  return entry?.viewable === true && hasId(entry) &&
    typeof entry.unavailable !== "string";
}

/**
 * Children to show. Only the `hidden` field decides; labels are never
 * inspected.
 */
export function visibleChildren(node, showHidden) {
  return showHidden
    ? node.children
    : node.children.filter((entry) => entry?.hidden !== true);
}

export function hiddenCount(node) {
  return node.children.reduce(
    (count, entry) => count + (entry?.hidden === true ? 1 : 0),
    0,
  );
}

/** A next page is available whatever the hidden filter shows. */
export function hasMore(node) {
  return node.nextOffset !== null;
}

/**
 * Begins a fetch. Offset 0 supersedes any fetch in flight; a later page is
 * allowed only at the announced next offset while nothing else is loading.
 * Returns null when the fetch must not be sent, otherwise the token for
 * `finishLoad` or `failLoad` and the id of the superseded request, if any.
 */
export function startLoad(explorer, node, offset) {
  if (explorer.closed) return null;
  let cancelId = null;
  if (offset === 0) {
    node.generation++;
    cancelId = node.requestId;
    node.stale = false;
  } else if (node.loading || node.nextOffset !== offset) {
    return null;
  }
  node.loading = true;
  node.error = null;
  node.requestId = null;
  return { generation: node.generation, offset, cancelId };
}

export function isCurrent(explorer, node, token) {
  return !explorer.closed && node.generation === token.generation;
}

/**
 * Applies a `resources/children` result. A stale token is ignored. Offset 0
 * replaces the listing and starts over; a later page appends the entries whose
 * ids are new. Entries without an id are never treated as duplicates. Returns
 * the request ids of fetches that dropped nodes had in flight.
 */
export function finishLoad(explorer, node, token, result) {
  if (!isCurrent(explorer, node, token)) {
    return { applied: false, cancelIds: [] };
  }
  if (
    !result || typeof result !== "object" || result.offset !== token.offset ||
    !Array.isArray(result.children)
  ) {
    throw new Error("The producer returned an invalid resource children page.");
  }
  const cancelIds = [];
  let children = node.children;
  let seen = node.seen;
  const previous = new Set(node.seen);
  if (token.offset === 0) {
    children = [];
    seen = new Set();
  }
  for (const entry of result.children) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (hasId(entry)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.has_children === true || explorer.nodes.has(entry.id)) {
        nodeFor(explorer, entry.id, entry);
      }
    }
    children.push(entry);
  }
  if (token.offset === 0) {
    for (const id of previous) {
      if (!seen.has(id)) cancelIds.push(...dropSubtree(explorer, id));
    }
  }
  node.children = children;
  node.seen = seen;
  node.total = Number.isSafeInteger(result.total_children) &&
      result.total_children >= 0
    ? result.total_children
    : null;
  node.nextOffset = Number.isSafeInteger(result.next_offset) &&
      result.next_offset > token.offset
    ? result.next_offset
    : null;
  node.loaded = true;
  node.loading = false;
  node.error = null;
  node.requestId = null;
  return { applied: true, cancelIds };
}

/** Records a failed fetch unless a newer one has replaced it. */
export function failLoad(explorer, node, token, message) {
  if (!isCurrent(explorer, node, token)) return false;
  node.loading = false;
  node.requestId = null;
  node.error = message;
  node.failedOffset = token.offset;
  return true;
}

/** Removes a node's record and those of its listed descendants. */
function dropSubtree(explorer, id, visited = new Set()) {
  if (visited.has(id)) return [];
  visited.add(id);
  const node = explorer.nodes.get(id);
  if (!node) return [];
  const cancelIds = node.requestId ? [node.requestId] : [];
  node.generation++;
  node.loading = false;
  for (const child of node.children) {
    if (hasId(child)) {
      cancelIds.push(...dropSubtree(explorer, child.id, visited));
    }
  }
  explorer.nodes.delete(id);
  return cancelIds;
}

/**
 * Expands a node. Returns true when its children must be fetched: they were
 * never loaded, or a refresh passed while the node was out of sight.
 */
export function expand(explorer, node) {
  node.expanded = true;
  return !explorer.closed && !node.loading && (!node.loaded || node.stale);
}

/**
 * Collapses a node and retires any fetch in flight for it. Returns the id of
 * the request to cancel, or null.
 */
export function collapse(node) {
  node.expanded = false;
  node.generation++;
  const cancelId = node.requestId;
  node.requestId = null;
  node.loading = false;
  return cancelId;
}

/**
 * Prepares a manual Refresh. The nodes the user can currently see (the root and
 * the expanded nodes reachable through expanded parents) are returned to be
 * fetched again from offset 0. Every other node is marked stale so it is
 * fetched again when it is next expanded, and its fetch in flight is retired.
 */
export function refreshAll(explorer) {
  const targets = [];
  const reached = new Set();
  const walk = (node) => {
    targets.push(node);
    reached.add(node);
    for (const entry of node.children) {
      if (!hasId(entry)) continue;
      const child = explorer.nodes.get(entry.id);
      if (child?.expanded && !reached.has(child)) walk(child);
    }
  };
  walk(explorer.root);
  const cancelIds = [];
  for (const node of explorer.nodes.values()) {
    if (reached.has(node)) continue;
    if (node.requestId) cancelIds.push(node.requestId);
    node.requestId = null;
    node.generation++;
    node.loading = false;
    if (node.loaded) node.stale = true;
  }
  return { targets, cancelIds };
}

/** Marks an Open as sent; false when one is already in flight for the node. */
export function beginOpen(explorer, id) {
  if (explorer.closed || explorer.opening.has(id)) return false;
  explorer.opening.add(id);
  return true;
}

export function endOpen(explorer, id) {
  explorer.opening.delete(id);
}

/** Ends the explorer: late responses are dropped. */
export function closeExplorer(explorer) {
  explorer.closed = true;
  explorer.opening.clear();
  explorer.nodes.clear();
}

/**
 * Remembers which views were first announced with reason "resource", so the
 * viewer keeps treating them as resource views after a later generation
 * arrives with another reason such as "refresh" or "tracked".
 */
export function createResourceViewTracker() {
  const views = new Set();
  const key = (session, view) => JSON.stringify([session, view]);
  return {
    note(session, descriptor) {
      const id = key(session, descriptor?.view);
      if (descriptor?.reason === "resource") views.add(id);
    },
    has(session, view) {
      return views.has(key(session, view));
    },
    forget(session, view) {
      views.delete(key(session, view));
    },
    forgetSession(session) {
      for (const id of [...views]) {
        if (JSON.parse(id)[0] === session) views.delete(id);
      }
    },
  };
}
