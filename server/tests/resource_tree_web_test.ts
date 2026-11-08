import { assert, assertEquals } from "./assert.ts";
import {
  beginOpen,
  canExpand,
  canOpen,
  collapse,
  createExplorer as createTypedExplorer,
  createResourceViewTracker,
  declaresResources,
  endOpen,
  expand,
  failLoad,
  finishLoad,
  hasMore,
  hiddenCount,
  nodeFor as typedNodeFor,
  nodeIdOf,
  normalizeKind,
  refreshAll,
  rowLabel,
  rowSummaryText,
  startLoad,
  visibleChildren,
} from "../web/resource_tree.js";

// deno-lint-ignore no-explicit-any
type Any = any;
const nodeFor = (...args: Any[]): Any => (typedNodeFor as Any)(...args);
const createExplorer = (): Any => createTypedExplorer();

const entry = (
  id: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  ...(id === undefined ? {} : { id }),
  label: id ?? "no id",
  kind: "table",
  has_children: false,
  viewable: true,
  ...extra,
});

const page = (
  offset: number,
  children: unknown[],
  next: number | null = null,
  total = 10,
) => ({
  node: null,
  offset,
  children,
  total_children: total,
  next_offset: next,
});

function load(explorer: Any, node: Any, offset: number, result: unknown) {
  const token = startLoad(explorer, node, offset);
  assert(token, "The fetch should start.");
  return finishLoad(explorer, node, token, result);
}

Deno.test("capability and kind helpers", () => {
  assert(declaresResources({ capabilities: { resources: true } }));
  assert(!declaresResources({ capabilities: { resources: false } }));
  assert(!declaresResources({ capabilities: { resources: "yes" } }));
  assert(!declaresResources({}));
  assert(!declaresResources(undefined));
  assertEquals(normalizeKind("table"), "table");
  assertEquals(normalizeKind("catalog"), "unknown");
  assertEquals(normalizeKind(undefined), "unknown");
  assertEquals(rowLabel({ label: "x" }), "x");
  assertEquals(rowLabel({}), "(unnamed)");
  assertEquals(
    rowSummaryText({ class: ["a", 1, "b"], summary: "s" }),
    "a, b · s",
  );
  assertEquals(rowSummaryText({}), "");
});

Deno.test("expand and open controls follow the node fields", () => {
  assert(canExpand(entry("a", { has_children: true })));
  assert(!canExpand(entry("a")));
  assert(!canExpand(entry(undefined, { has_children: true })));
  assert(
    !canExpand(entry("a", { has_children: true, unavailable: "stale" })),
  );
  assert(canOpen(entry("a")));
  assert(!canOpen(entry("a", { viewable: false })));
  assert(!canOpen(entry("a", { unavailable: "stale" })));
  assert(!canOpen(entry(undefined)));
});

Deno.test("later pages append by next_offset and drop duplicate ids", () => {
  const explorer = createExplorer();
  const root = explorer.root;
  load(explorer, root, 0, page(0, [entry("a"), entry("b")], 2));
  assertEquals(root.nextOffset, 2);
  // A page that is not at next_offset is not requested.
  assertEquals(startLoad(explorer, root, 5), null);
  load(
    explorer,
    root,
    2,
    page(2, [entry("b"), entry("c"), entry(undefined), entry(undefined)], null),
  );
  assertEquals(
    root.children.map((child: Any) => child.id ?? "none"),
    ["a", "b", "c", "none", "none"],
  );
  assert(!hasMore(root));
  // Fetching again from offset 0 starts the duplicate set over.
  load(explorer, root, 0, page(0, [entry("c"), entry("b")], null));
  assertEquals(root.children.map((child: Any) => child.id), ["c", "b"]);
});

Deno.test("a next page cannot start while a fetch is in flight", () => {
  const explorer = createExplorer();
  const root = explorer.root;
  load(explorer, root, 0, page(0, [entry("a")], 1));
  const token = startLoad(explorer, root, 1);
  assert(token);
  assertEquals(startLoad(explorer, root, 1), null);
  assert(failLoad(explorer, root, token, "boom"));
  assertEquals(root.error, "boom");
  assertEquals(root.failedOffset, 1);
  assert(startLoad(explorer, root, 1));
});

Deno.test("hidden filtering uses the hidden field only", () => {
  const explorer = createExplorer();
  const root = explorer.root;
  load(
    explorer,
    root,
    0,
    page(0, [
      entry(".dotted"),
      entry("quiet", { hidden: true }),
      entry("flag", { hidden: false }),
    ], 3),
  );
  assertEquals(
    visibleChildren(root, false).map((child: Any) => child.id),
    [".dotted", "flag"],
  );
  assertEquals(visibleChildren(root, true).length, 3);
  assertEquals(hiddenCount(root), 1);
});

Deno.test("a page of only hidden nodes keeps the next page entry", () => {
  const explorer = createExplorer();
  const root = explorer.root;
  load(
    explorer,
    root,
    0,
    page(0, [entry("h1", { hidden: true }), entry("h2", { hidden: true })], 2),
  );
  assertEquals(visibleChildren(root, false), []);
  assert(hasMore(root));
});

Deno.test("a refresh makes an older response obsolete", () => {
  const explorer = createExplorer();
  const root = explorer.root;
  const first = startLoad(explorer, root, 0)!;
  root.requestId = "req-1";
  const second = startLoad(explorer, root, 0)!;
  assertEquals(second.cancelId, "req-1");
  const stale = finishLoad(explorer, root, first, page(0, [entry("old")]));
  assertEquals(stale.applied, false);
  assertEquals(root.children, []);
  assert(!failLoad(explorer, root, first, "late"));
  assertEquals(root.error, null);
  assert(finishLoad(explorer, root, second, page(0, [entry("new")])).applied);
  assertEquals(root.children.map((child: Any) => child.id), ["new"]);
});

Deno.test("collapsing retires the fetch in flight", () => {
  const explorer = createExplorer();
  const node = nodeFor(explorer, ["n"], entry("n", { has_children: true }));
  assert(expand(explorer, node));
  const token = startLoad(explorer, node, 0)!;
  node.requestId = "req-2";
  assertEquals(collapse(node), "req-2");
  assertEquals(
    finishLoad(explorer, node, token, page(0, [entry("x")])).applied,
    false,
  );
  assertEquals(node.loaded, false);
  // Expanding again fetches, because nothing was loaded.
  assert(expand(explorer, node));
});

Deno.test("refresh targets the visible expanded nodes and marks the rest stale", () => {
  const explorer = createExplorer();
  load(
    explorer,
    explorer.root,
    0,
    page(0, [entry("p", { has_children: true })]),
  );
  const p = nodeFor(explorer, ["p"]);
  expand(explorer, p);
  load(
    explorer,
    p,
    0,
    page(0, [
      entry("q", { has_children: true }),
      entry("r", { has_children: true }),
    ]),
  );
  const q = nodeFor(explorer, ["p", "q"]);
  const r = nodeFor(explorer, ["p", "r"]);
  // Sibling nodes are expanded at the same time.
  expand(explorer, q);
  expand(explorer, r);
  load(explorer, q, 0, page(0, [entry("q1")]));
  load(explorer, r, 0, page(0, [entry("r1")]));
  // r is hidden behind a collapsed parent after p collapses.
  collapse(p);
  let { targets } = refreshAll(explorer);
  assertEquals(targets, [explorer.root]);
  assert(p.stale && q.stale && r.stale);
  // Expanding the parent again fetches it because it was marked stale.
  expand(explorer, p);
  ({ targets } = refreshAll(explorer));
  assertEquals(targets.length, 4);
  assert(targets.includes(q) && targets.includes(r));
});

Deno.test("a refresh drops the state of nodes that disappeared", () => {
  const explorer = createExplorer();
  load(
    explorer,
    explorer.root,
    0,
    page(0, [
      entry("keep", { has_children: true }),
      entry("gone", { has_children: true }),
    ]),
  );
  const gone = nodeFor(explorer, ["gone"]);
  gone.requestId = "req-3";
  gone.loading = true;
  const result = load(
    explorer,
    explorer.root,
    0,
    page(0, [
      entry("keep", { has_children: true }),
    ]),
  );
  assertEquals(result.cancelIds, ["req-3"]);
  assert(!explorer.nodes.has(JSON.stringify(["gone"])));
  assert(explorer.nodes.has(JSON.stringify(["keep"])));
});

Deno.test("an invalid page is rejected and a closed explorer ignores responses", () => {
  const explorer = createExplorer();
  const token = startLoad(explorer, explorer.root, 0)!;
  let failed = false;
  try {
    finishLoad(explorer, explorer.root, token, page(5, []));
  } catch {
    failed = true;
  }
  assert(failed);
  explorer.closed = true;
  assertEquals(startLoad(explorer, explorer.root, 0), null);
  assertEquals(
    finishLoad(explorer, explorer.root, token, page(0, [])).applied,
    false,
  );
});

Deno.test("only one Open is in flight per node", () => {
  const explorer = createExplorer();
  assert(beginOpen(explorer, "t"));
  assert(!beginOpen(explorer, "t"));
  assert(beginOpen(explorer, "u"));
  endOpen(explorer, "t");
  assert(beginOpen(explorer, "t"));
});

Deno.test("resource views stay recognized across generations until closed", () => {
  const tracker = createResourceViewTracker();
  tracker.note("s", { view: "v", generation: 1, reason: "resource" });
  tracker.note("s", { view: "other", generation: 1, reason: "register" });
  tracker.note("s", { view: "v", generation: 2, reason: "refresh" });
  assert(tracker.has("s", "v"));
  assert(!tracker.has("s", "other"));
  assert(!tracker.has("t", "v"));
  tracker.forget("s", "v");
  assert(!tracker.has("s", "v"));
  tracker.note("s", { view: "a", generation: 1, reason: "resource" });
  tracker.note("t", { view: "a", generation: 1, reason: "resource" });
  tracker.forgetSession("s");
  assert(!tracker.has("s", "a") && tracker.has("t", "a"));
});

const key = (...path: string[]) => JSON.stringify(path);
const dir = (id: string) => entry(id, { has_children: true, viewable: false });
const tables = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => dir(`n${from + index}`));

// Runs a refresh the way the viewer does: sweep requests until no more.
function sweep(
  explorer: Any,
  node: Any,
  answer: (offset: number) => unknown,
): string[] {
  const offsets: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const token = startLoad(explorer, node, offset, { refresh: true });
    assert(token, `The sweep should request offset ${offset}.`);
    offsets.push(String(offset));
    const result = finishLoad(explorer, node, token, answer(offset));
    assert(result.applied);
    offset = result.continueAt;
  }
  return offsets;
}

function loadedParent() {
  const explorer = createExplorer();
  const root = explorer.root;
  load(explorer, root, 0, page(0, [dir("p")], null, 1));
  const p = nodeFor(explorer, ["p"]);
  expand(explorer, p);
  load(explorer, p, 0, page(0, tables(0, 200), 200, 300));
  load(explorer, p, 200, page(200, tables(200, 300), null, 300));
  return { explorer, root, p };
}

Deno.test("a refresh reads the loaded pages again and keeps the state of a node on page two", () => {
  const { explorer, root, p } = loadedParent();
  // Node 220 lives on the second page and is expanded.
  const deep = nodeFor(explorer, ["p", "n220"], dir("n220"));
  expand(explorer, deep);
  load(explorer, deep, 0, page(0, [entry("leaf")]));
  const { targets } = refreshAll(explorer);
  assertEquals(targets.length, 3);
  assert(
    targets.includes(root) && targets.includes(p) && targets.includes(deep),
  );
  const offsets = sweep(
    explorer,
    p,
    (offset) =>
      offset === 0
        ? page(0, tables(0, 200), 200, 300)
        : page(200, tables(200, 300), null, 300),
  );
  assertEquals(offsets, ["0", "200"]);
  assertEquals(p.children.length, 300);
  assert(!hasMore(p));
  assert(deep.expanded && deep.loaded);
  assertEquals(deep.children.length, 1);
  assert(explorer.nodes.has(key("p", "n220")));
});

Deno.test("the listing stays whole until the sweep has finished", () => {
  const { explorer, p } = loadedParent();
  const first = startLoad(explorer, p, 0, { refresh: true })!;
  const result = finishLoad(
    explorer,
    p,
    first,
    page(0, tables(0, 200), 200, 300),
  );
  assertEquals(result.continueAt, 200);
  assertEquals(p.children.length, 300);
  // A refresh in progress does not allow Load more or another page.
  assertEquals(startLoad(explorer, p, 5), null);
  const second = startLoad(explorer, p, 200, { refresh: true })!;
  finishLoad(explorer, p, second, page(200, tables(200, 300), null, 300));
  assertEquals(p.children.length, 300);
});

Deno.test("only nodes missing from the fully re-read listing are dropped", () => {
  const { explorer, p } = loadedParent();
  for (const id of ["n10", "n220", "n290"]) {
    const record = nodeFor(explorer, ["p", id], dir(id));
    expand(explorer, record);
  }
  // n220 is gone; the rest of the listing, including n290, is still there.
  const fresh = [...tables(0, 220), ...tables(221, 300)];
  const offsets = sweep(
    explorer,
    p,
    (offset) =>
      offset === 0
        ? page(0, fresh.slice(0, 200), 200, 299)
        : page(200, fresh.slice(200), null, 299),
  );
  assertEquals(offsets, ["0", "200"]);
  assert(explorer.nodes.has(key("p", "n10")));
  assert(explorer.nodes.has(key("p", "n290")));
  assert(!explorer.nodes.has(key("p", "n220")));
});

Deno.test("a refresh that reads only part of a listing drops nothing", () => {
  const { explorer, p } = loadedParent();
  const deep = nodeFor(explorer, ["p", "n250"], dir("n250"));
  expand(explorer, deep);
  // A plain first-page fetch with more pages to come cannot prove deletions.
  load(explorer, p, 0, page(0, tables(0, 200), 200, 300));
  assertEquals(p.children.length, 200);
  assert(explorer.nodes.has(key("p", "n250")));
  assert(deep.expanded);
  // The state is back once the node is listed again.
  load(explorer, p, 200, page(200, tables(200, 300), null, 300));
  assert(explorer.nodes.has(key("p", "n250")));
  // When the listing ends without it, the record is discarded.
  load(explorer, p, 0, page(0, tables(0, 100), null, 100));
  assert(!explorer.nodes.has(key("p", "n250")));
});

Deno.test("a sweep goes on until an expanded node that moved is found again", () => {
  const { explorer, p } = loadedParent();
  const moved = nodeFor(explorer, ["p", "n5"], dir("n5"));
  expand(explorer, moved);
  // n5 moved to the end of a listing that has grown past what was loaded.
  const fresh = [...tables(0, 5), ...tables(6, 300), dir("n5")];
  const offsets = sweep(
    explorer,
    p,
    (offset) =>
      offset === 0
        ? page(0, fresh.slice(0, 200), 200, 300)
        : page(200, fresh.slice(200), null, 300),
  );
  assertEquals(offsets, ["0", "200"]);
  assert(moved.expanded);
  assertEquals(p.children.length, 300);
  assertEquals(p.children[299].id, "n5");
});

Deno.test("a node listed under two parents has independent state", () => {
  const explorer = createExplorer();
  load(explorer, explorer.root, 0, page(0, [dir("a"), dir("b")], null, 2));
  const a = nodeFor(explorer, ["a"]);
  const b = nodeFor(explorer, ["b"]);
  expand(explorer, a);
  expand(explorer, b);
  load(explorer, a, 0, page(0, [dir("shared"), dir("only_a")]));
  load(explorer, b, 0, page(0, [dir("shared")]));
  const underA = nodeFor(explorer, ["a", "shared"]);
  const underB = nodeFor(explorer, ["b", "shared"]);
  assert(underA !== underB);
  assertEquals(nodeIdOf(underA), "shared");
  assertEquals(nodeIdOf(explorer.root), null);
  expand(explorer, underA);
  assert(underA.expanded && !underB.expanded);
  expand(explorer, underB);
  load(explorer, underB, 0, page(0, [entry("leaf")]));
  collapse(underA);
  assert(!underA.expanded && underB.expanded && underB.loaded);
  // Dropping it from one parent leaves the other alone.
  load(explorer, a, 0, page(0, [dir("only_a")]));
  assert(!explorer.nodes.has(key("a", "shared")));
  assert(explorer.nodes.has(key("b", "shared")));
  assert(underB.expanded);
  assertEquals(underB.children.length, 1);
  // A refresh walks both parents' expanded copies separately.
  expand(explorer, nodeFor(explorer, ["a", "only_a"]));
  const { targets } = refreshAll(explorer);
  assert(targets.includes(underB));
  assertEquals(targets.length, 5);
});

Deno.test("dropping a node drops its subtree and cancels its fetches", () => {
  const explorer = createExplorer();
  load(explorer, explorer.root, 0, page(0, [dir("a"), dir("keep")], null, 2));
  const a = nodeFor(explorer, ["a"]);
  expand(explorer, a);
  load(explorer, a, 0, page(0, [dir("inner")]));
  const inner = nodeFor(explorer, ["a", "inner"]);
  expand(explorer, inner);
  startLoad(explorer, inner, 0);
  inner.requestId = "req-inner";
  const result = load(
    explorer,
    explorer.root,
    0,
    page(0, [dir("keep")], null, 1),
  );
  assertEquals(result.cancelIds, ["req-inner"]);
  assert(
    !explorer.nodes.has(key("a")) && !explorer.nodes.has(key("a", "inner")),
  );
});

Deno.test("a stale sweep response is discarded", () => {
  const { explorer, p } = loadedParent();
  const old = startLoad(explorer, p, 0, { refresh: true })!;
  const newer = startLoad(explorer, p, 0, { refresh: true })!;
  const stale = finishLoad(explorer, p, old, page(0, tables(0, 200), 200, 300));
  assertEquals(stale.applied, false);
  assertEquals(stale.continueAt, null);
  assert(
    finishLoad(explorer, p, newer, page(0, tables(0, 200), 200, 300)).applied,
  );
  // Collapsing mid-sweep retires it and leaves the node stale.
  const third = startLoad(explorer, p, 200, { refresh: true })!;
  collapse(p);
  assertEquals(
    finishLoad(explorer, p, third, page(200, tables(200, 300))).applied,
    false,
  );
  assert(p.stale);
  assertEquals(p.children.length, 300);
});

Deno.test("retrying a refresh whose first page failed sweeps the loaded range again", () => {
  const { explorer, p } = loadedParent();
  const failed = startLoad(explorer, p, 0, { refresh: true })!;
  assert(failLoad(explorer, p, failed, "timeout"));
  assertEquals(p.failedOffset, 0);
  // The Retry button asks for the failed offset without any options.
  const offsets: number[] = [];
  let offset: number | null = p.failedOffset;
  while (offset !== null) {
    const token = startLoad(explorer, p, offset);
    assert(token?.sweep, "The retry should continue as a sweep.");
    offsets.push(offset);
    const result = finishLoad(
      explorer,
      p,
      token,
      offset === 0
        ? page(0, tables(0, 200), 200, 300)
        : page(200, tables(200, 300), null, 300),
    );
    offset = result.continueAt;
  }
  assertEquals(offsets, [0, 200]);
  assertEquals(p.children.length, 300);
  assert(!hasMore(p));
  assertEquals(p.sweep, null);
});

Deno.test("retrying a sweep page that failed halfway resumes at that page", () => {
  const { explorer, p } = loadedParent();
  const first = startLoad(explorer, p, 0, { refresh: true })!;
  finishLoad(explorer, p, first, page(0, tables(0, 200), 200, 300));
  const second = startLoad(explorer, p, 200)!;
  assert(failLoad(explorer, p, second, "timeout"));
  assertEquals(p.failedOffset, 200);
  // The listing on screen is untouched while the sweep waits for the retry.
  assertEquals(p.children.length, 300);
  const retry = startLoad(explorer, p, p.failedOffset)!;
  assert(retry.sweep);
  finishLoad(explorer, p, retry, page(200, tables(200, 300), null, 300));
  assertEquals(p.children.length, 300);
  assertEquals(p.sweep, null);
});

Deno.test("retrying an ordinary failed load is not a sweep", () => {
  const explorer = createExplorer();
  const failed = startLoad(explorer, explorer.root, 0)!;
  assert(failLoad(explorer, explorer.root, failed, "boom"));
  const retry = startLoad(explorer, explorer.root, explorer.root.failedOffset)!;
  assertEquals(retry.sweep, false);
  // A loaded node whose plain reload failed is not turned into a sweep either.
  const { explorer: loaded, p } = loadedParent();
  const reload = startLoad(loaded, p, 0)!;
  assert(failLoad(loaded, p, reload, "boom"));
  assertEquals(startLoad(loaded, p, p.failedOffset)!.sweep, false);
});
