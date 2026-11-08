// Browser-side state for a session's Resource Tree explorer.
//
// Everything here is DOM-free so the bookkeeping can be unit tested. The
// explorer keeps one node record per path plus a root record. A path is the
// list of node ids from the root down to the node, so a node that the producer
// lists under two parents has two independent records (expansion state,
// children, paging). A record owns its listed children, the next offset the
// producer announced, and a local fetch generation. The fetch generation is
// private to the browser and is not a view generation: it only lets the
// explorer drop responses that a refresh, a collapse, or a newer fetch has
// made obsolete.
//
// A record is discarded only when the producer has shown that the node is gone:
// the parent's listing was fetched through its last page (`next_offset` null)
// and the node did not appear in it. A listing that is only partly fetched
// again never discards anything.

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

function createNode(entry, path) {
  return {
    entry,
    path,
    sweep: null,
    loadedEnd: 0,
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
    root: createNode(null, []),
    nodes: new Map(),
    opening: new Set(),
    closed: false,
  };
}

function pathKey(path) {
  return JSON.stringify(path);
}

/** The path of a child listed under `node`. */
export function childPath(node, id) {
  return [...node.path, id];
}

/**
 * Returns the record at a path (an array of node ids from the root),
 * creating it on first use; an empty or missing path is the root.
 */
export function nodeFor(explorer, path, entry = null) {
  if (!Array.isArray(path) || path.length === 0) return explorer.root;
  const key = pathKey(path);
  let node = explorer.nodes.get(key);
  if (!node) {
    node = createNode(entry, [...path]);
    explorer.nodes.set(key, node);
  } else if (entry) node.entry = entry;
  return node;
}

/** The existing record of a child listed under `node`, if any. */
export function existingChild(explorer, node, id) {
  return explorer.nodes.get(pathKey(childPath(node, id)));
}

/** A stable string for a node's path, usable as a DOM key. */
export function nodeKey(node) {
  return pathKey(node.path);
}

/** The node id sent in `resources/children`; `null` addresses the root. */
export function nodeIdOf(node) {
  return node.path.length === 0 ? null : node.path[node.path.length - 1];
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
 * With `refresh` an already loaded node is fetched again as a sweep: its
 * current listing stays in place while the pages are read again from offset 0
 * (see `finishLoad`), and the caller keeps requesting the offset the result
 * announces as `continueAt`. Returns null when the fetch must not be sent,
 * otherwise the token for `finishLoad` or `failLoad` and the id of the
 * superseded request, if any.
 */
export function startLoad(explorer, node, offset, options = {}) {
  if (explorer.closed) return null;
  let cancelId = null;
  if (offset === 0) {
    node.generation++;
    cancelId = node.requestId;
    node.stale = false;
    // A sweep left behind by a failed first page is retried as a sweep: only
    // a failure keeps `node.sweep` set when a fetch starts at offset 0.
    node.sweep = (options.refresh || node.sweep) && node.loaded
      ? { end: node.loadedEnd, children: [], seen: new Set(), nextOffset: 0 }
      : null;
  } else if (node.sweep) {
    if (node.loading || node.sweep.nextOffset !== offset) return null;
  } else if (node.loading || node.nextOffset !== offset) {
    return null;
  }
  node.loading = true;
  node.error = null;
  node.requestId = null;
  return {
    generation: node.generation,
    offset,
    cancelId,
    sweep: node.sweep !== null,
  };
}

export function isCurrent(explorer, node, token) {
  return !explorer.closed && node.generation === token.generation;
}

function nextOffsetOf(result, offset) {
  return Number.isSafeInteger(result.next_offset) && result.next_offset > offset
    ? result.next_offset
    : null;
}

/** Whether a listed child of `node` is expanded but not in `seen`. */
function expandedMissing(explorer, node, seen) {
  const depth = node.path.length + 1;
  for (const record of explorer.nodes.values()) {
    if (
      record.expanded && record.path.length === depth &&
      !seen.has(record.path[depth - 1]) && isChildPath(node.path, record.path)
    ) return true;
  }
  return false;
}

function isChildPath(parent, path) {
  return path.length === parent.length + 1 &&
    parent.every((id, index) => path[index] === id);
}

/**
 * Applies a `resources/children` result. A stale token is ignored. Offset 0
 * replaces the listing; a later page appends the entries whose ids are new.
 * Entries without an id are never treated as duplicates.
 *
 * A node's record is discarded only when this result ends the listing
 * (`next_offset` null) and the node is not in it; a listing that is read only
 * in part, such as the first page after a refresh, keeps every record.
 *
 * A sweep (see `startLoad`) collects the fresh pages aside and swaps them in
 * when it is complete, so the listing the user sees does not shrink while
 * pages are in flight. It is complete once the fresh pages reach the end of
 * what was loaded before and every expanded child has been found again, or
 * the listing ends. Until then the result carries `continueAt`, the offset of
 * the next fetch.
 *
 * Returns the request ids of fetches that dropped nodes had in flight.
 */
export function finishLoad(explorer, node, token, result) {
  if (!isCurrent(explorer, node, token)) {
    return { applied: false, cancelIds: [], continueAt: null };
  }
  if (
    !result || typeof result !== "object" || result.offset !== token.offset ||
    !Array.isArray(result.children)
  ) {
    throw new Error("The producer returned an invalid resource children page.");
  }
  const sweep = token.sweep && node.sweep ? node.sweep : null;
  let children = sweep ? sweep.children : node.children;
  let seen = sweep ? sweep.seen : node.seen;
  if (!sweep && token.offset === 0) {
    children = [];
    seen = new Set();
  }
  for (const entry of result.children) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (hasId(entry)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const path = childPath(node, entry.id);
      if (entry.has_children === true || explorer.nodes.has(pathKey(path))) {
        nodeFor(explorer, path, entry);
      }
    }
    children.push(entry);
  }
  const next = nextOffsetOf(result, token.offset);
  node.total = Number.isSafeInteger(result.total_children) &&
      result.total_children >= 0
    ? result.total_children
    : null;
  node.loaded = true;
  node.loading = false;
  node.error = null;
  node.requestId = null;
  if (
    sweep && next !== null &&
    (next < sweep.end || expandedMissing(explorer, node, seen))
  ) {
    sweep.nextOffset = next;
    return { applied: true, cancelIds: [], continueAt: next };
  }
  node.sweep = null;
  node.children = children;
  node.seen = seen;
  node.nextOffset = next;
  node.loadedEnd = next ?? token.offset + result.children.length;
  const cancelIds = [];
  if (next === null) {
    // The whole listing is known: records of nodes that are not in it are gone.
    for (const record of [...explorer.nodes.values()]) {
      if (
        isChildPath(node.path, record.path) &&
        !seen.has(record.path[record.path.length - 1])
      ) {
        cancelIds.push(...dropSubtree(explorer, record.path));
      }
    }
  }
  return { applied: true, cancelIds, continueAt: null };
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

/** Removes the record at a path and the records of everything below it. */
function dropSubtree(explorer, path) {
  const cancelIds = [];
  for (const [key, record] of [...explorer.nodes]) {
    if (
      record.path.length >= path.length &&
      path.every((id, index) => record.path[index] === id)
    ) {
      if (record.requestId) cancelIds.push(record.requestId);
      record.generation++;
      record.loading = false;
      explorer.nodes.delete(key);
    }
  }
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
  if (node.sweep) {
    node.sweep = null;
    if (node.loaded) node.stale = true;
  }
  node.generation++;
  const cancelId = node.requestId;
  node.requestId = null;
  node.loading = false;
  return cancelId;
}

/**
 * Prepares a manual Refresh. The nodes the user can currently see (the root and
 * the expanded nodes reachable through expanded parents) are returned to be
 * fetched again as sweeps from offset 0. Every other node is marked stale so
 * it is fetched again when it is next expanded, and its fetch in flight is
 * retired.
 */
export function refreshAll(explorer) {
  const targets = [];
  const reached = new Set();
  const walk = (node) => {
    targets.push(node);
    reached.add(node);
    for (const entry of node.children) {
      if (!hasId(entry)) continue;
      const child = existingChild(explorer, node, entry.id);
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
    node.sweep = null;
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
