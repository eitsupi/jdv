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
  const node = nodeFor(explorer, "n", entry("n", { has_children: true }));
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
  const p = nodeFor(explorer, "p");
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
  const q = nodeFor(explorer, "q");
  const r = nodeFor(explorer, "r");
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
  const gone = nodeFor(explorer, "gone");
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
  assert(!explorer.nodes.has("gone"));
  assert(explorer.nodes.has("keep"));
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
