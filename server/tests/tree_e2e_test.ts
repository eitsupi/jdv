import { assert, assertEquals } from "./assert.ts";
import type { Page } from "@astral/astral";
import { join } from "node:path";
import { ArfSession } from "./helpers/arf_session.ts";
import {
  finishIntegrationCleanup,
  removeCacheDirectory,
} from "./integration_cleanup.ts";
import { type TestBrowser, TestServer } from "./helpers/test_server.ts";
import { bodyDeadline, launchOwnedBrowser, phase } from "./bounded_browser.ts";
import {
  click,
  clickButton,
  collectPageErrors,
  count,
  evaluate,
  text,
  texts,
  waitFor,
} from "./astral_page.ts";

const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");

interface E2EDomElement {
  textContent: string | null;
  tagName: string;
  disabled: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: E2EDomElement | null): boolean;
  querySelector(selector: string): E2EDomElement | null;
  querySelectorAll(selector: string): E2EDomElement[];
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

declare const document: {
  querySelector(selector: string): E2EDomElement | null;
  querySelectorAll(selector: string): E2EDomElement[];
  elementFromPoint(x: number, y: number): E2EDomElement | null;
};
declare function getComputedStyle(element: E2EDomElement): {
  display: string;
  visibility: string;
  pointerEvents: string;
  opacity: string;
};

let rEvaluationSequence = 0;

function rEval(
  arf: ArfSession,
  code: string,
  timeoutMs = 30_000,
): Promise<Awaited<ReturnType<ArfSession["eval"]>>> {
  const sequence = ++rEvaluationSequence;
  return phase(
    `Tree E2E R evaluation ${sequence}`,
    () => arf.eval(code, timeoutMs),
    timeoutMs + 3_000,
  );
}

/** Evaluate through R's REPL so task callbacks (variable tracking) run. */
function rEvalVisible(arf: ArfSession, code: string, timeoutMs = 30_000) {
  const sequence = ++rEvaluationSequence;
  return phase(
    `R visible evaluation ${sequence}`,
    () => arf.evalVisible(code, timeoutMs),
    timeoutMs + 3_000,
  );
}

interface Runtime {
  server: TestServer;
  arf: ArfSession;
  browser: TestBrowser;
  session: string;
  root: Record<string, unknown>;
}

const pendingMessages = new WeakMap<TestBrowser, Record<string, unknown>[]>();

function asRecord(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object.",
  );
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "Expected an array.");
  return value;
}

function rQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface TreeActionExpectation {
  breadcrumbButtons: number;
  breadcrumbTextIncludes?: string;
  childIndex: number;
  rowTextIncludes?: string;
  pageLabelIncludes?: string;
  childCount?: number;
}

function treeActionReady(
  args: { selector: string; expected: TreeActionExpectation },
): boolean {
  const status = document.querySelector("#status");
  const tree = document.querySelector("#tree-viewer");
  const row = document.querySelector(
    `#tree-child-list li[data-child-index="${args.expected.childIndex}"]`,
  );
  const target = document.querySelector(args.selector);
  const style = target ? getComputedStyle(target) : undefined;
  const rect = target?.getBoundingClientRect();
  const children = document.querySelectorAll("#tree-child-list > li");
  const breadcrumbButtons = document.querySelectorAll(
    "#tree-breadcrumb [data-tree-depth]",
  );
  const breadcrumbText = document.querySelector("#tree-breadcrumb")
    ?.textContent ?? "";
  return status?.getAttribute("data-state") === "connected" &&
    tree?.hasAttribute("hidden") === false &&
    breadcrumbButtons.length === args.expected.breadcrumbButtons &&
    (args.expected.breadcrumbTextIncludes === undefined ||
      breadcrumbText.includes(args.expected.breadcrumbTextIncludes)) &&
    (args.expected.childCount === undefined ||
      children.length === args.expected.childCount) &&
    (args.expected.pageLabelIncludes === undefined ||
      document.querySelector("#tree-page-label")?.textContent?.includes(
          args.expected.pageLabelIncludes,
        ) === true) &&
    row !== null &&
    (args.expected.rowTextIncludes === undefined ||
      row.textContent?.includes(args.expected.rowTextIncludes) === true) &&
    target !== null && target.disabled === false &&
    target.hasAttribute("hidden") === false && style?.display !== "none" &&
    style?.visibility !== "hidden" && style?.visibility !== "collapse" &&
    style?.pointerEvents !== "none" && style?.opacity !== "0" &&
    rect !== undefined && rect.width > 0 && rect.height > 0;
}

async function treeActionSnapshot(
  page: Page,
  selector: string,
) {
  return await evaluate(
    page,
    (targetSelector) => {
      const status = document.querySelector("#status");
      const tree = document.querySelector("#tree-viewer");
      const list = document.querySelector("#tree-child-list");
      const pageLabel = document.querySelector("#tree-page-label");
      const breadcrumb = document.querySelector("#tree-breadcrumb");
      const target = document.querySelector(targetSelector);
      const rect = target?.getBoundingClientRect();
      const style = target ? getComputedStyle(target) : undefined;
      const hit = rect && rect.width > 0 && rect.height > 0
        ? document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        )
        : null;
      const describe = (element: E2EDomElement | null) =>
        element
          ? {
            tag: element.tagName,
            id: element.getAttribute("id"),
            action: element.getAttribute("data-action"),
            childIndex: element.getAttribute("data-child-index"),
            text: (element.textContent ?? "").slice(0, 120),
          }
          : null;
      return {
        status: {
          state: status?.getAttribute("data-state"),
          text: (status?.textContent ?? "").slice(0, 160),
        },
        treeHidden: tree?.hasAttribute("hidden") ?? null,
        breadcrumb: {
          text: (breadcrumb?.textContent ?? "").slice(0, 240),
          buttons: document.querySelectorAll(
            "#tree-breadcrumb [data-tree-depth]",
          ).length,
        },
        pageLabel: (pageLabel?.textContent ?? "").slice(0, 120),
        childCount: document.querySelectorAll("#tree-child-list > li").length,
        children: Array.from(
          document.querySelectorAll("#tree-child-list > li"),
        )
          .slice(0, 20)
          .map((row) => ({
            index: row.getAttribute("data-child-index"),
            text: (row.textContent ?? "").slice(0, 120),
            actions: Array.from(row.querySelectorAll("[data-action]")).map(
              describe,
            ),
          })),
        targetCount: document.querySelectorAll(targetSelector).length,
        target: target
          ? {
            ...describe(target),
            disabled: target.disabled,
            hidden: target.hasAttribute("hidden"),
            display: style?.display,
            visibility: style?.visibility,
            pointerEvents: style?.pointerEvents,
            opacity: style?.opacity,
            rect: rect
              ? {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }
              : null,
            hit: describe(hit),
            hitWithinTarget: target.contains(hit),
          }
          : null,
        listText: (list?.textContent ?? "").slice(0, 400),
      };
    },
    { args: [selector] },
  );
}

async function clickReadyTreeAction(
  page: Page,
  selector: string,
  expected: TreeActionExpectation,
) {
  try {
    await waitFor(page, treeActionReady, { selector, expected }, {
      timeout: 8_000,
    });
    await click(page, selector);
  } catch (error) {
    let snapshot: unknown;
    try {
      snapshot = await treeActionSnapshot(page, selector);
    } catch (diagnosticError) {
      snapshot = { diagnosticError: String(diagnosticError) };
    }
    throw new Error(
      `Tree action ${selector} did not become ready or complete its click. ` +
        `Original failure: ${String(error)}. DOM snapshot: ${
          JSON.stringify(snapshot)
        }`,
      { cause: error },
    );
  }
}

async function nextMessage(
  browser: TestBrowser,
  predicate: (message: Record<string, unknown>) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const pending = pendingMessages.get(browser) ?? [];
  pendingMessages.set(browser, pending);
  const pendingIndex = pending.findIndex(predicate);
  if (pendingIndex >= 0) return pending.splice(pendingIndex, 1)[0];

  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    const message = await browser.read(remaining);
    if (predicate(message)) return message;
    if (message.type === "error") {
      throw new Error(
        `Unexpected browser error while waiting for ${description}: ${
          JSON.stringify(message)
        }`,
      );
    }
    pending.push(message);
  }
}

async function openedView(
  browser: TestBrowser,
  title: string,
): Promise<Record<string, unknown>> {
  const event = await nextMessage(
    browser,
    (message) => {
      if (message.type !== "view/open") return false;
      const envelope = asRecord(message.message);
      return asRecord(envelope.params).title === title;
    },
    `view/open for ${title}`,
  );
  return {
    ...asRecord(asRecord(event.message).params),
    _session: String(event.session),
  };
}

async function request(
  browser: TestBrowser,
  session: string,
  view: string,
  generation: number,
  method: string,
  params: Record<string, unknown> = {},
  id = `tree-${crypto.randomUUID()}`,
): Promise<Record<string, unknown>> {
  browser.send({
    type: "request",
    id,
    session,
    method,
    params: { view, generation, ...params },
  });
  return await nextMessage(
    browser,
    (message) =>
      (message.type === "response" || message.type === "error") &&
      message.id === id,
    `response ${id}`,
  );
}

function responseResult(
  message: Record<string, unknown>,
): Record<string, unknown> {
  assert(
    message.type === "response" && !message.error,
    `Request failed: ${JSON.stringify(message.error ?? message)}`,
  );
  return asRecord(message.result);
}

function notificationMethod(message: Record<string, unknown>): unknown {
  return (message.message as Record<string, unknown> | undefined)?.method;
}

function responseErrorCode(message: Record<string, unknown>): unknown {
  return asRecord(message.error ?? message).code;
}

function lastStep(child: Record<string, unknown>): Record<string, unknown> {
  const path = asArray(child.path);
  assert(path.length > 0, "A non-root child path must contain a step.");
  return asRecord(path.at(-1));
}

function childByPath(
  children: unknown[],
  type: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const child = children.map(asRecord).find((entry) => {
    const step = lastStep(entry);
    return step.type === type && step[key] === value;
  });
  assert(child, `Missing ${type} child ${String(value)}.`);
  return child;
}

function treeFixtureCode(): string {
  return [
    "jdv_tree_counts <- new.env(parent = emptyenv())",
    "jdv_tree_counts$active <- 0L; jdv_tree_counts$promise <- 0L; jdv_tree_counts$dispatch <- 0L",
    "jdv_tree_active_env <- new.env(parent = emptyenv())",
    'makeActiveBinding("active", function(value) { if (missing(value)) { jdv_tree_counts$active <- jdv_tree_counts$active + 1L; "active-value" } else stop("read-only") }, jdv_tree_active_env)',
    'delayedAssign("deferred", { jdv_tree_counts$promise <- jdv_tree_counts$promise + 1L; "promise-value" }, assign.env = jdv_tree_active_env, eval.env = .GlobalEnv)',
    "jdv_tree_active_env$ordinary <- 42L",
    "jdv_tree_cycle_env <- new.env(parent = emptyenv()); jdv_tree_cycle_env$self <- jdv_tree_cycle_env",
    "jdv_tree_capture_env <- new.env(parent = emptyenv()); jdv_tree_capture_env$df <- data.frame(value = c(17L, 18L), check.names = FALSE)",
    'if (!methods::isClass("jdv_tree_fixture_s4")) methods::setClass("jdv_tree_fixture_s4", slots = c(items = "list"))',
    'jdv_tree_s4 <- methods::new("jdv_tree_fixture_s4", items = list(slot_value = 7L))',
    "jdv_tree_pair <- as.pairlist(list(left = 1L, right = 2L))",
    'jdv_tree_classed <- structure(list(one = 1L, two = 2L), class = "jdv_tree_classed_list")',
    '`[[.jdv_tree_classed_list` <- function(x, i, ...) { jdv_tree_counts$dispatch <- jdv_tree_counts$dispatch + 1L; stop("classed list dispatch must not run") }',
    "jdv_tree_captured <- data.frame(value = c(17L, 18L), check.names = FALSE)",
    'jdv_tree_root <- list("duplicate-first", "duplicate-second", unname(list("unnamed-one", "unnamed-two")), seq_len(1200L), data.frame(value = c(31L, 32L), check.names = FALSE), jdv_tree_active_env, jdv_tree_cycle_env, jdv_tree_s4, jdv_tree_pair, jdv_tree_captured, "html-label-value", jdv_tree_classed, "empty-name-value", jdv_tree_capture_env)',
    'names(jdv_tree_root) <- c("duplicate", "duplicate", "unnamed", "long atomic", "nested frame", "environment", "cycle", "S4 object", "pairlist", "captured", "<img src=x onerror=alert(1)>", "classed list", "", "capture environment")',
    'attr(jdv_tree_root, "inspect") <- list(note = "attribute-value")',
    'jdv_view(jdv_tree_root, title = "Tree E2E fixture")',
  ].join("; ");
}

async function startRuntime(
  fixtureCode = treeFixtureCode(),
  fixtureTitle = "Tree E2E fixture",
): Promise<Runtime> {
  assert(testLibrary, "JDV_TEST_R_LIB must select the scratch library.");
  const server = new TestServer();
  const arf = new ArfSession();
  let startedServer = false;
  let startedArf = false;
  let browser: TestBrowser | undefined;
  try {
    startedServer = true;
    await phase("Tree E2E server startup", () => server.start(), 30_000);
    startedArf = true;
    await phase(
      "Tree E2E arf startup",
      () => arf.start({ env: server.rEnv(testLibrary) }),
      60_000,
    );
    const libraryPath = rQuote(testLibrary);
    const loaded = await rEval(
      arf,
      `.libPaths(c(${libraryPath}, .libPaths())); ` +
        `library(jdv, lib.loc = ${libraryPath}); ` +
        `cat("JDV_TEST_R_LIB", normalizePath(getNamespaceInfo(asNamespace("jdv"), "path"), winslash = "/"), ` +
        `getLoadedDLLs()[["jdv"]][["path"]], sep = "\\t"); cat("\\n")`,
    );
    console.log(`Loaded tree E2E R package and DLL:\n${loaded.stdout ?? ""}`);
    browser = await phase(
      "Tree E2E browser connection",
      () => server.connectBrowser(),
      30_000,
    );
    const welcome = await phase(
      "Tree E2E browser welcome",
      () => browser!.read(10_000),
      12_000,
    );
    assertEquals(welcome.type, "welcome");
    await rEval(arf, fixtureCode);
    const root = await openedView(browser, fixtureTitle);
    return {
      server,
      arf,
      browser,
      session: String(root._session),
      root,
    };
  } catch (error) {
    await finishIntegrationCleanup([
      ...(browser
        ? [
          () =>
            phase(
              "Tree E2E startup browser cleanup",
              () => Promise.resolve(browser!.close()),
              10_000,
            ),
        ]
        : []),
      ...(startedArf
        ? [
          () =>
            phase("Tree E2E startup arf cleanup", () => arf.close(), 50_000),
        ]
        : []),
      ...(startedServer
        ? [
          () =>
            phase(
              "Tree E2E startup server cleanup",
              () => server.close(),
              10_000,
            ),
        ]
        : []),
    ], [error]);
    throw error;
  }
}

Deno.test({
  name: "real R tree viewer pages typed children and opens grid children",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtime = await startRuntime();
    let screenshotDir: string | undefined;
    let primaryError: unknown;
    let closeChromium: (() => Promise<void>) | undefined;
    try {
      await bodyDeadline("Tree E2E overall body", async () => {
        const { server, arf, browser, session, root } = runtime;
        assertEquals(root.kind, "tree");
        assertEquals(root.access, "random");
        const capabilities = asRecord(root.capabilities);
        assertEquals(capabilities.children, true);
        assertEquals(capabilities.sort, false);
        assertEquals(capabilities.filter, false);

        const rootPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: [], offset: 0, limit: 500 },
          ),
        );
        const rootChildren = asArray(rootPage.children);
        const firstDuplicate = childByPath(rootChildren, "index", "index", 1);
        const secondDuplicate = childByPath(rootChildren, "index", "index", 2);
        assertEquals(lastStep(firstDuplicate).index, 1);
        assertEquals(lastStep(secondDuplicate).index, 2);
        const emptyName = childByPath(rootChildren, "index", "index", 13);
        assertEquals(lastStep(emptyName).index, 13);

        const unnamed = childByPath(rootChildren, "index", "index", 3);
        const unnamedPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: unnamed.path, offset: 0, limit: 20 },
          ),
        );
        const unnamedChildren = asArray(unnamedPage.children);
        assertEquals(lastStep(asRecord(unnamedChildren[0])).type, "index");
        assertEquals(lastStep(asRecord(unnamedChildren[0])).index, 1);

        const longAtomic = childByPath(rootChildren, "index", "index", 4);
        const longPages = [];
        for (const offset of [0, 500, 1000]) {
          const page = responseResult(
            await request(
              browser,
              session,
              String(root.view),
              Number(root.generation),
              "object/children",
              { path: longAtomic.path, offset, limit: 500 },
            ),
          );
          assertEquals(page.total_children, 1200);
          const children = asArray(page.children);
          assertEquals(children.length, offset === 1000 ? 200 : 500);
          longPages.push(children);
        }
        assertEquals(lastStep(asRecord(longPages[0][0])).index, 1);
        assertEquals(lastStep(asRecord(longPages[1][0])).index, 501);
        assertEquals(lastStep(asRecord(longPages[2][199])).index, 1200);

        const envChild = childByPath(rootChildren, "index", "index", 6);
        const environmentPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: envChild.path, offset: 0, limit: 20 },
          ),
        );
        const environmentChildren = asArray(environmentPage.children).map(
          asRecord,
        );
        const active = environmentChildren.find((child) =>
          child.label === "active"
        );
        const deferred = environmentChildren.find((child) =>
          child.label === "deferred"
        );
        assert(active, "Active binding was omitted from the child list.");
        assert(deferred, "Promise binding was omitted from the child list.");
        assertEquals(active.viewable, false);
        assertEquals(deferred.viewable, false);

        const cycleEnv = childByPath(rootChildren, "index", "index", 7);
        let cyclePath = cycleEnv.path;
        let cycleStopped = false;
        for (let depth = 0; depth < 8; depth++) {
          const cyclePage = responseResult(
            await request(
              browser,
              session,
              String(root.view),
              Number(root.generation),
              "object/children",
              { path: cyclePath, offset: 0, limit: 10 },
            ),
          );
          const cycleChildren = asArray(cyclePage.children).map(asRecord);
          const self = cycleChildren.find((child) =>
            lastStep(child).type === "binding" &&
            lastStep(child).name === "self"
          );
          if (!self || self.has_children !== true) {
            cycleStopped = true;
            break;
          }
          cyclePath = self.path;
        }
        assert(
          cycleStopped,
          "A self-referential environment did not stop expanding.",
        );

        const s4 = childByPath(rootChildren, "index", "index", 8);
        const s4Page = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: s4.path, offset: 0, limit: 10 },
          ),
        );
        const slot = childByPath(
          asArray(s4Page.children),
          "slot",
          "name",
          "items",
        );
        const slotPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: slot.path, offset: 0, limit: 10 },
          ),
        );
        assert(asArray(slotPage.children).length > 0);

        const pair = childByPath(rootChildren, "index", "index", 9);
        const pairPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: pair.path, offset: 0, limit: 10 },
          ),
        );
        assertEquals(
          asArray(pairPage.children).map(asRecord).filter((child) =>
            lastStep(child).type === "index"
          ).length,
          2,
        );

        const classed = childByPath(rootChildren, "index", "index", 12);
        const classedPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: classed.path, offset: 0, limit: 10 },
          ),
        );
        assertEquals(
          asArray(classedPage.children).map(asRecord).filter((child) =>
            lastStep(child).type === "index"
          ).length,
          2,
        );

        const attr = childByPath(rootChildren, "attr", "name", "inspect");
        assertEquals(lastStep(attr).name, "inspect");

        const captured = childByPath(rootChildren, "index", "index", 10);
        const opened = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: captured.path },
          ),
        );
        assertEquals(opened.kind, "grid");
        assertEquals(opened.parent, root.view);
        const childView = String(opened.view);
        const openedEvent = await nextMessage(
          browser,
          (message) => {
            if (message.type !== "view/open") return false;
            return asRecord(asRecord(message.message).params).view ===
              childView;
          },
          "child grid view/open event",
        );
        assertEquals(
          asRecord(asRecord(openedEvent.message).params).parent,
          root.view,
        );

        const captureEnv = childByPath(rootChildren, "index", "index", 14);
        const captureEnvPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: captureEnv.path, offset: 0, limit: 10 },
          ),
        );
        const captureBinding = childByPath(
          asArray(captureEnvPage.children),
          "binding",
          "name",
          "df",
        );
        const capturePath = captureBinding.path;
        const oldChild = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: capturePath },
          ),
        );
        assertEquals(oldChild.kind, "grid");
        await rEval(
          arf,
          "jdv_tree_capture_env$df <- data.frame(value = c(99L, 100L), check.names = FALSE)",
        );
        const newChild = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: capturePath },
          ),
        );
        assertEquals(newChild.kind, "grid");
        assert(
          oldChild.view !== newChild.view,
          "Reopening a replaced environment binding should capture a new child view.",
        );

        const counterResult = await rEval(
          arf,
          "c(jdv_tree_counts$active, jdv_tree_counts$promise, jdv_tree_counts$dispatch)",
        );
        assert(
          counterResult.value?.trim().endsWith("0 0 0"),
          `Tree enumeration evaluated guarded values or dispatched [[ : ${counterResult.value}`,
        );

        const stale = await request(
          browser,
          session,
          String(root.view),
          Number(root.generation) + 1,
          "object/children",
          { path: [], offset: 0, limit: 10 },
        );
        assertEquals(responseErrorCode(stale), "stale_generation");

        const closeResult = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "view/close",
          ),
        );
        assertEquals(closeResult.closed, true);
        await nextMessage(
          browser,
          (message) =>
            message.type === "view/closed" &&
            asRecord(message.message).params !== undefined &&
            asRecord(asRecord(message.message).params).view === childView &&
            asRecord(asRecord(message.message).params).reason ===
              "parent_closed",
          "cascaded child close",
        );
        const missing = await request(
          browser,
          session,
          String(root.view),
          Number(root.generation),
          "object/children",
          { path: [], offset: 0, limit: 10 },
        );
        // The implicit connection ends after its last view closes, but the
        // hub may still see the session until R's EOF is processed.
        const missingCode = responseErrorCode(missing);
        assert(
          missingCode === "session_not_found" ||
            missingCode === "view_not_found",
          `Unexpected error after closing the root: ${missingCode}`,
        );
        await nextMessage(
          browser,
          (message) =>
            message.type === "session/closed" && message.session === session,
          "implicit session close after the last view",
        );

        {
          const ownedBrowser = await launchOwnedBrowser({
            ...(browserExecutable ? { path: browserExecutable } : {}),
            args: ["--no-sandbox"],
            ...(browserLibraryPath
              ? {
                env: {
                  ...Deno.env.toObject(),
                  LD_LIBRARY_PATH: browserLibraryPath,
                },
              }
              : {}),
          });
          closeChromium = () => ownedBrowser.close();
          const chromiumBrowser = ownedBrowser.browser;
          const page = await phase(
            "Tree E2E new page",
            async () => {
              const page = await chromiumBrowser.newPage("about:blank", {
                waitUntil: "none",
              });
              await page.setViewportSize({ width: 1200, height: 850 });
              return page;
            },
            20_000,
          );
          const pageErrors: string[] = [];
          collectPageErrors(page, pageErrors);
          await phase(
            "Tree E2E navigation and session connection",
            async () => {
              await page.goto(server.url, { waitUntil: "load" });
              await page.waitForSelector('#status[data-state="connected"]');
              await rEval(arf, treeFixtureCode());
              await openedView(browser, "Tree E2E fixture");
            },
            40_000,
          );
          await phase("Tree E2E browser inspection actions", async () => {
            await clickButton(page, "Open object");
            await page.waitForSelector(
              "#tree-viewer:not([hidden]) li[data-child-index]",
            );
            await Deno.writeFile(
              join(
                screenshotDir ??= await Deno.makeTempDir({
                  prefix: "jdv-tree-screenshot-",
                }),
                "tree-root.png",
              ),
              await page.screenshot(),
            );
            assertEquals(await count(page, "#tree-child-list img"), 0);
            assert(
              (await text(page, "#tree-meta"))?.includes("list (list)"),
              "The tree meta line must show the root class and type.",
            );
            await waitFor(
              page,
              () =>
                document.querySelector("#tree-page-label")?.textContent
                  ?.includes("of 16 children") === true,
            );
            await click(page, "#tree-attributes");
            await waitFor(
              page,
              () =>
                document.querySelector("#tree-page-label")?.textContent
                  ?.includes("of 14 children") === true,
            );
            await click(page, "#tree-attributes");
            await waitFor(
              page,
              () =>
                document.querySelector("#tree-page-label")?.textContent
                  ?.includes("of 16 children") === true,
            );
            assert(
              (await text(page, '#tree-child-list li[data-child-index="11"]'))
                ?.includes("<img src=x onerror=alert(1)>"),
              "HTML-like child label must remain visible as text.",
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="14"] [data-action="expand-child"]',
            );
            await clickReadyTreeAction(
              page,
              '#tree-child-list li[data-child-index="1"] [data-action="open-child"]',
              {
                breadcrumbButtons: 1,
                breadcrumbTextIncludes: "capture environment",
                childIndex: 1,
                rowTextIncludes: "df",
                childCount: 1,
              },
            );
            await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
            const capturedCells = await texts(page, "#viewer .tabulator-cell");
            assert(
              capturedCells.includes("17") && capturedCells.includes("18"),
              `Expected the opened child to show its captured values: ${capturedCells}`,
            );
            await rEval(
              arf,
              "jdv_tree_capture_env$df <- data.frame(value = c(99L, 100L), check.names = FALSE)",
            );
            const cellsAfterParentChange = await texts(
              page,
              "#viewer .tabulator-cell",
            );
            assert(
              cellsAfterParentChange.includes("17") &&
                cellsAfterParentChange.includes("18") &&
                !cellsAfterParentChange.includes("99") &&
                !cellsAfterParentChange.includes("100"),
              `The opened child changed after its parent binding changed: ${cellsAfterParentChange}`,
            );
            await click(page, "#tree-return");
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await clickReadyTreeAction(
              page,
              '#tree-child-list li[data-child-index="1"] [data-action="open-child"]',
              {
                breadcrumbButtons: 1,
                breadcrumbTextIncludes: "capture environment",
                childIndex: 1,
                rowTextIncludes: "df",
                childCount: 1,
              },
            );
            await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
            const reopenedCells = await texts(page, "#viewer .tabulator-cell");
            assert(
              reopenedCells.includes("99") && reopenedCells.includes("100"),
              `A newly opened child should show the replacement binding: ${reopenedCells}`,
            );
            await click(page, "#tree-return");
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await click(page, '#tree-breadcrumb [data-tree-depth="0"]');
            await waitFor(
              page,
              () =>
                document.querySelector(
                  '#tree-child-list li[data-child-index="3"]',
                )?.textContent?.includes("unnamed") === true,
            );
            await click(
              page,
              '#tree-child-list li[data-child-index="3"] [data-action="expand-child"]',
            );
            await waitFor(
              page,
              () =>
                document.querySelector("#tree-breadcrumb")?.textContent
                  ?.includes("unnamed") === true,
            );
            await click(page, '#tree-breadcrumb [data-tree-depth="0"]');
            await clickReadyTreeAction(
              page,
              '#tree-child-list li[data-child-index="5"] [data-action="open-child"]',
              {
                breadcrumbButtons: 0,
                breadcrumbTextIncludes: "Tree E2E fixture",
                childIndex: 5,
                rowTextIncludes: "nested frame",
                childCount: 16,
                pageLabelIncludes: "of 16 children",
              },
            );
            await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
            await Deno.writeFile(
              join(screenshotDir!, "tree-nested-grid.png"),
              await page.screenshot(),
            );
            await click(page, "#tree-return");
            await page.waitForSelector("#tree-viewer:not([hidden])");
            await waitFor(
              page,
              () =>
                document.querySelectorAll(
                  '#tree-breadcrumb [data-tree-depth="1"]',
                ).length === 0,
            );
            assertEquals(pageErrors, []);
          }, 150_000);
        }
      }, 300_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        ...(closeChromium
          ? [() => phase("Tree E2E Chromium cleanup", closeChromium!, 50_000)]
          : []),
        () => runtime.browser.close(),
        () => phase("Tree E2E arf cleanup", () => runtime.arf.close(), 50_000),
        () =>
          phase(
            "Tree E2E server cleanup",
            () => runtime.server.close(),
            10_000,
          ),
        ...(screenshotDir ? [() => removeCacheDirectory(screenshotDir!)] : []),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

Deno.test({
  name: "real R view/refresh replaces a view and delivers its own response",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtime = await startRuntime();
    let primaryError: unknown;
    try {
      await bodyDeadline("Tree E2E refresh body", async () => {
        const { browser, session, root } = runtime;
        assertEquals(asRecord(root.capabilities).refresh, true);
        const rootPage = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/children",
            { path: [], offset: 0, limit: 500 },
          ),
        );
        const captured = childByPath(
          asArray(rootPage.children),
          "index",
          "index",
          10,
        );
        const opened = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation),
            "object/open",
            { path: captured.path },
          ),
        );
        const childView = String(opened.view);
        await nextMessage(
          browser,
          (message) =>
            message.type === "view/open" &&
            asRecord(asRecord(message.message).params).view === childView,
          "child grid view/open event",
        );

        const id = "refresh-root";
        browser.send({
          type: "request",
          id,
          session,
          method: "view/refresh",
          params: { view: root.view, generation: root.generation },
        });
        // R queues the child closes and the new view/open before the
        // response, and the hub must still deliver that response.
        const seen: Record<string, unknown>[] = [];
        for (;;) {
          const message = await browser.read(10_000);
          seen.push(message);
          if (message.type === "response" || message.type === "error") break;
        }
        const response = seen[seen.length - 1];
        assert(response.type === "response", JSON.stringify(response));
        assertEquals(response.id, id);
        const result = responseResult(response);
        assertEquals(result.previous_generation, root.generation);
        assertEquals(result.generation, Number(root.generation) + 1);
        assertEquals(result.refreshed, true);
        const kinds = seen.slice(0, -1).map((message) => {
          const params = asRecord(asRecord(message.message).params);
          return `${message.type}:${params.view}:${params.generation}:${
            params.reason ?? ""
          }`;
        });
        assertEquals(kinds, [
          `view/closed:${childView}:${opened.generation}:parent_closed`,
          `view/open:${root.view}:${Number(root.generation) + 1}:refresh`,
        ]);

        const stale = await request(
          browser,
          session,
          String(root.view),
          Number(root.generation),
          "view/refresh",
        );
        assertEquals(responseErrorCode(stale), "stale_generation");
        const next = responseResult(
          await request(
            browser,
            session,
            String(root.view),
            Number(root.generation) + 1,
            "object/children",
            { path: [], offset: 0, limit: 5 },
          ),
        );
        assertEquals(next.generation, Number(root.generation) + 1);
      }, 120_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => runtime.browser.close(),
        () => phase("Tree E2E arf cleanup", () => runtime.arf.close(), 50_000),
        () =>
          phase(
            "Tree E2E server cleanup",
            () => runtime.server.close(),
            10_000,
          ),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

Deno.test({
  name: "top-level R tasks update a tracked view and report a failed update",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    assert(testLibrary, "JDV_TEST_R_LIB must select the scratch library.");
    const server = new TestServer();
    let browser: TestBrowser | undefined;
    let directory: string | undefined;
    let child: Deno.ChildProcess | undefined;
    let primaryError: unknown;
    try {
      await phase("Tracking E2E server startup", () => server.start(), 30_000);
      browser = await server.connectBrowser();
      const welcome = await browser.read(10_000);
      assertEquals(welcome.type, "welcome");
      directory = await Deno.makeTempDir({ prefix: "jdv-track-" });
      const release = join(directory, "release");
      const script = join(directory, "track.R");
      // Rscript evaluates a script file one top-level expression at a time,
      // which is when jdv's task callback looks at the tracked variable.
      await Deno.writeTextFile(
        script,
        [
          `library(jdv, lib.loc = ${rQuote(testLibrary)})`,
          "tracked_df <- mtcars[1:3, ]",
          'jdv_view(tracked_df, mode = "snapshot")',
          "tracked_df <- mtcars[1:5, ]",
          "same <- tracked_df",
          "tracked_df <- same",
          "options(jdv.max_message_bytes = 2048)",
          "tracked_df <- mtcars[rep(1:32, 20), ]",
          "options(jdv.max_message_bytes = NULL)",
          "tracked_df <- mtcars[1:4, ]",
          `while (!file.exists(${rQuote(release)})) Sys.sleep(0.05)`,
          "jdv_close()",
        ].join("\n") + "\n",
      );
      child = new Deno.Command("Rscript", {
        args: [script],
        env: server.rEnv(testLibrary),
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const first = await openedView(browser, "tracked_df");
      assertEquals(first.generation, 1);
      assertEquals(first.nrow, 3);
      const isViewOpen = (message: Record<string, unknown>) =>
        message.type === "view/open" &&
        asRecord(asRecord(message.message).params).view === first.view;
      const second = await nextMessage(
        browser,
        isViewOpen,
        "view/open for the reassigned variable",
      );
      const reopened = asRecord(asRecord(second.message).params);
      assertEquals(reopened.generation, 2);
      assertEquals(reopened.nrow, 5);

      // The next notification is the failure: assigning the same object
      // again changed nothing, and the failed candidate keeps generation 2.
      const failed = await nextMessage(
        browser,
        (message) =>
          message.type === "notification" ||
          message.type === "view/open",
        "view/update_failed",
      );
      assertEquals(failed.type, "notification");
      assertEquals(asRecord(failed.message).method, "view/update_failed");
      const params = asRecord(asRecord(failed.message).params);
      assertEquals(params.view, first.view);
      assertEquals(params.generation, 2);
      assertEquals(params.code, "limit_exceeded");

      const third = await nextMessage(
        browser,
        isViewOpen,
        "view/open after the failed update",
      );
      const last = asRecord(asRecord(third.message).params);
      assertEquals(last.generation, 3);
      assertEquals(last.nrow, 4);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        ...(directory
          ? [async () => {
            await Deno.writeTextFile(join(directory!, "release"), "");
          }]
          : []),
        ...(child
          ? [async () => {
            const output = await phase(
              "Tracking E2E R exit",
              () => child!.output(),
              30_000,
            );
            if (primaryError !== undefined) {
              console.log(new TextDecoder().decode(output.stderr));
            }
          }]
          : []),
        ...(browser ? [() => Promise.resolve(browser!.close())] : []),
        () =>
          phase("Tracking E2E server cleanup", () => server.close(), 10_000),
        ...(directory ? [() => removeCacheDirectory(directory!)] : []),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

Deno.test({
  name: "real R view/track pauses and resumes a tracked view",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtime = await startRuntime(
      'tracked_df <- mtcars[1:3, ]; jdv_view(tracked_df, mode = "snapshot")',
      "tracked_df",
    );
    let primaryError: unknown;
    try {
      await bodyDeadline("Track E2E body", async () => {
        const { arf, browser, session, root } = runtime;
        const view = String(root.view);
        assertEquals(root.generation, 1);
        assertEquals(asRecord(root.tracking), {
          name: "tracked_df",
          state: "active",
        });
        assertEquals(asRecord(root.capabilities).track, true);

        const paused = responseResult(
          await request(browser, session, view, 1, "view/track", {
            enabled: false,
          }),
        );
        assertEquals(paused.generation, 1);
        assertEquals(asRecord(paused.tracking).state, "paused");
        // R queued the notification before the response.
        const notice = await nextMessage(
          browser,
          (message) => notificationMethod(message) === "view/tracking",
          "view/tracking for the pause",
        );
        assertEquals(
          asRecord(asRecord(notice.message).params).tracking,
          { name: "tracked_df", state: "paused" },
        );

        // A change while paused is not followed.
        // A visible evaluation runs through R's REPL, so the tracking task
        // callback fires after it.
        await rEvalVisible(arf, "tracked_df <- mtcars[1:5, ]");
        assertEquals(
          (pendingMessages.get(browser) ?? []).filter((message) =>
            message.type === "view/open"
          ).length,
          0,
        );

        // Resuming sees the change and rebuilds the view.
        const resumed = responseResult(
          await request(browser, session, view, 1, "view/track", {
            enabled: true,
          }),
        );
        assertEquals(resumed.generation, 2);
        assertEquals(asRecord(resumed.tracking).state, "active");
        const reopened = await nextMessage(
          browser,
          (message) => message.type === "view/open",
          "view/open for the resumed view",
        );
        const params = asRecord(asRecord(reopened.message).params);
        assertEquals(params.generation, 2);
        assertEquals(params.reason, "tracked");
        assertEquals(params.nrow, 5);
        assertEquals(asRecord(params.tracking).state, "active");

        // Removing the variable ends following and says why.
        await rEvalVisible(arf, "rm(tracked_df)");
        const lost = await nextMessage(
          browser,
          (message) =>
            notificationMethod(message) === "view/tracking" &&
            asRecord(asRecord(asRecord(message.message).params).tracking)
                .state ===
              "lost",
          "view/tracking for the removed variable",
        );
        const lostParams = asRecord(asRecord(lost.message).params);
        assertEquals(lostParams.generation, 2);
        assertEquals(asRecord(lostParams.tracking).reason, "removed");
        assertEquals(typeof asRecord(lostParams.tracking).message, "string");
        assertEquals(
          responseErrorCode(
            await request(browser, session, view, 2, "view/track", {
              enabled: false,
            }),
          ),
          "unsupported",
        );
      }, 120_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => runtime.browser.close(),
        () => phase("Track E2E arf cleanup", () => runtime.arf.close(), 50_000),
        () =>
          phase(
            "Track E2E server cleanup",
            () => runtime.server.close(),
            10_000,
          ),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});
