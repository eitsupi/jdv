import type { Page } from "@astral/astral";
import {
  click,
  clickButton,
  collectPageErrors,
  count,
  evaluate,
  texts,
  waitFor,
  waitForSelector,
} from "./astral_page.ts";
import { launchOwnedBrowser, phase } from "./bounded_browser.ts";
import { finishIntegrationCleanup } from "./integration_cleanup.ts";
import { assert, assertEquals } from "./assert.ts";
import { NonRProducerHarness } from "./fixtures/non_r_producer.ts";

const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");

type BrowserDocument = {
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): { textContent: string | null }[];
};

const labels = (page: Page) => texts(page, "#resources .resource-label");

function waitForLabels(
  page: Page,
  predicate: (labels: string[]) => boolean,
  description: string,
) {
  return (async () => {
    const deadline = Date.now() + 15_000;
    let last: string[] = [];
    while (Date.now() < deadline) {
      last = await labels(page);
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out waiting for ${description}; saw ${last.length} labels: ${
        JSON.stringify(last.slice(0, 12))
      }`,
    );
  })();
}

async function launch() {
  return await launchOwnedBrowser({
    path: browserExecutable,
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
}

Deno.test({
  name:
    "Resource Tree explorer browses, opens, refreshes, and ends with the session",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = await NonRProducerHarness.start({
      capabilities: { resources: true },
    });
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    const producer = harness.producer;
    try {
      owned = await launch();
      await phase("resource explorer test body", async () => {
        page = await owned!.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.goto(harness.url, { waitUntil: "load" });

        // The explorer is there with no view open and no view in the session.
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll("#resources .resource-explorer").length === 1,
        );
        assertEquals(await count(page, "#tables article"), 0);
        // The root lists main and locked; the node marked hidden is not shown.
        assertEquals(
          await waitForLabels(
            page,
            (value) => value.length === 2,
            "the root listing",
          ),
          ["main", "locked"],
        );
        assertEquals(
          await evaluate(
            page,
            () =>
              Array.from(
                (globalThis as unknown as { document: BrowserDocument })
                  .document.querySelectorAll("#resources .resource-row"),
              )
                .find((row) => row.textContent?.includes("locked"))
                ?.textContent ?? "",
          ),
          "▣lockedUnavailable: permission_denied",
        );
        // Unknown kind tokens ("catalog") are treated as unknown.
        assert(
          (await count(page, '#resources [data-kind="unknown"]')) >= 1,
          "An unrecognized kind should be shown as unknown.",
        );
        assertEquals(
          await count(
            page,
            '#resources .resource-row button[data-action="open-resource"]',
          ),
          0,
        );

        // Nested expansion keeps both ancestors expanded.
        await clickButton(
          page,
          "Expand main",
          "#resources .resource-row",
          0,
          "main",
        );
        await waitForLabels(
          page,
          (value) => value.includes("public"),
          "the main catalog children",
        );
        await clickButton(
          page,
          "Expand public",
          "#resources .resource-row",
          0,
          "public",
        );
        let current = await waitForLabels(
          page,
          (value) => value.includes("table_000"),
          "the first table page",
        );
        assertEquals(current.slice(0, 4), [
          "main",
          "public",
          "table_000",
          "table_001",
        ]);
        assertEquals(await count(page, '[aria-expanded="true"]'), 2);
        const tablesOnFirstPage = current.filter((label) =>
          label.startsWith("table_")
        );
        // 200 listed on the first page, one of them hidden.
        assertEquals(tablesOnFirstPage.length, 199);
        assert(!current.includes("table_007"), "A hidden node is not shown.");

        // The next page is requested at next_offset, not at the shown count.
        await clickButton(page, "Load more", "#resources .resource-more");
        current = await waitForLabels(
          page,
          (value) => value.includes("table_249"),
          "the second table page",
        );
        assertEquals(
          current.filter((label) => label.startsWith("table_")).length,
          249,
        );
        const pageRequests = producer.resourceRequests.filter((request) =>
          request.params.node === "s:main.public"
        );
        assertEquals(pageRequests.map((request) => request.params.offset), [
          0,
          200,
        ]);
        assertEquals(await count(page, '[data-action="load-more"]'), 0);

        // The hidden toggle only filters; it does not fetch again.
        const before = producer.resourceRequests.length;
        await click(page, '[data-action="toggle-hidden"]');
        current = await waitForLabels(
          page,
          (value) => value.includes("table_007"),
          "hidden nodes",
        );
        assert(current.includes("temp"), "The hidden catalog is shown.");
        assertEquals(
          current.filter((label) => label.startsWith("table_")).length,
          250,
        );
        assertEquals(producer.resourceRequests.length, before);
        await click(page, '[data-action="toggle-hidden"]');
        current = await waitForLabels(
          page,
          (value) => !value.includes("table_007"),
          "hidden nodes to disappear",
        );
        assert(!current.includes("temp"));

        // Open registers a grid view that the existing viewer shows.
        await clickButton(
          page,
          "Open",
          "#resources .resource-row",
          0,
          "table_000",
        );
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelector("#table-title")?.textContent === "table_000",
        );
        await waitForSelector(page, '.tabulator-row [tabulator-field="c0"]');
        const opens = producer.resourceRequests.filter((request) =>
          request.method === "resources/open"
        );
        assertEquals(opens.map((request) => request.params.node), [
          "t:public.table_000",
        ]);
        assertEquals(await count(page, "#tables article"), 1);

        // Refresh fetches the listing again and keeps the open view and the
        // expansion state.
        producer.addRootTable("fresh_table");
        await clickButton(page, "Refresh", "#resources .resource-explorer");
        current = await waitForLabels(
          page,
          (value) => value.includes("fresh_table"),
          "the refreshed root listing",
        );
        assertEquals(current.filter((label) => label === "public").length, 1);
        assertEquals(await count(page, '[aria-expanded="true"]'), 2);
        assertEquals(await count(page, "#tables article"), 1);
        assertEquals(
          await evaluate(
            page,
            () =>
              (globalThis as unknown as { document: BrowserDocument }).document
                .querySelector("#table-title")?.textContent,
          ),
          "table_000",
        );

        // A later generation with another reason keeps the Close control.
        producer.reannounce(producer.lastResourceDescriptor!, 2, "refresh");
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
                .querySelectorAll("#tables article").length === 1 &&
            (globalThis as unknown as { document: BrowserDocument }).document
                .querySelector("#tables article")?.textContent?.includes(
                  "Close view",
                ) === true,
        );

        // The replaced generation is displayed again before the next step.
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll(".tabulator-row").length === 3,
        );
        // Closing the view leaves the explorer in place.
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll("#resources .resource-note").length === 0,
        );
        await clickButton(page, "Close view", "#tables article");
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll("#tables article").length === 0,
        );
        current = await labels(page);
        assert(current.includes("table_000") && current.includes("main"));

        // A response made obsolete by a newer refresh is dropped.
        const held: { id: string }[] = [];
        producer.onResource = (request) => {
          if (
            request.method === "resources/children" &&
            request.params.node === null
          ) {
            held.push({ id: request.id });
            return true;
          }
          return false;
        };
        await clickButton(page, "Refresh", "#resources .resource-explorer");
        await clickButton(page, "Refresh", "#resources .resource-explorer");
        const started = Date.now();
        while (held.length < 2 && Date.now() - started < 3_000) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(held.length >= 1, "The root refresh should reach the producer.");
        const root = (label: string) => ({
          node: null,
          offset: 0,
          children: [{
            id: `t:${label}`,
            label,
            kind: "table",
            has_children: false,
            viewable: true,
          }],
          total_children: 1,
          next_offset: null,
        });
        await producer.respond(held[held.length - 1].id, root("newest_root"));
        await waitForLabels(
          page,
          (value) => value.includes("newest_root"),
          "the newest root listing",
        );
        if (held.length > 1) {
          await producer.respond(held[0].id, root("obsolete_root"));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        current = await labels(page);
        assert(!current.includes("obsolete_root"));
        assert(current.includes("newest_root"));
        producer.onResource = undefined;

        // Without the resource_changes capability nothing is subscribed.
        assert(
          !producer.resourceRequests.some((request) =>
            request.method === "resources/subscribe"
          ),
        );

        // The explorer ends with its session.
        producer.close();
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll("#resources .resource-explorer").length === 0,
        );
      });
      assertEquals(pageErrors, []);
    } finally {
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => harness.close(),
      ]);
    }
  },
});

Deno.test({
  name: "A session without the resources capability has no explorer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = await NonRProducerHarness.start();
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    try {
      harness.producer.openSnapshot();
      owned = await launch();
      await phase("capability-less explorer test body", async () => {
        page = await owned!.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.goto(harness.url, { waitUntil: "load" });
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll("#tables article").length === 1,
        );
        await waitFor(
          page,
          () =>
            (globalThis as unknown as { document: BrowserDocument }).document
              .querySelectorAll("#sessions article").length === 1,
        );
        assertEquals(await count(page, "#resources .resource-explorer"), 0);
        assertEquals(harness.producer.resourceRequests.length, 0);
        assertEquals(harness.producer.subscribeRequests, []);
      });
      assertEquals(pageErrors, []);
    } finally {
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => harness.close(),
      ]);
    }
  },
});

type Box = { left: number; top: number; right: number; bottom: number };

type Layout = {
  panel: Box;
  explorer: Box;
  explorerScrolls: boolean;
  tables: Box;
  viewer: Box;
  innerHeight: number;
  innerWidth: number;
  open: boolean;
  summaryHidden: boolean;
  documentWidth: number;
};

function layout(page: Page): Promise<Layout> {
  return evaluate(page, () => {
    const doc = (globalThis as unknown as {
      document: {
        querySelector(selector: string): {
          getBoundingClientRect(): Box;
          scrollHeight: number;
          clientHeight: number;
          open: boolean;
        } | null;
        documentElement: { scrollWidth: number };
      };
    }).document;
    const win = globalThis as unknown as {
      innerHeight: number;
      innerWidth: number;
      scrollY: number;
      getComputedStyle(element: unknown): { display: string };
    };
    // Positions are relative to the document, so scrolling does not matter.
    const box = (selector: string): Box => {
      const rect = doc.querySelector(selector)!.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top + win.scrollY,
        right: rect.right,
        bottom: rect.bottom + win.scrollY,
      };
    };
    const explorer = doc.querySelector("#resources")!;
    return {
      panel: box("#resources-panel"),
      explorer: box("#resources"),
      explorerScrolls: explorer.scrollHeight > explorer.clientHeight,
      tables: box("#sessions"),
      viewer: box("#viewer"),
      innerHeight: win.innerHeight,
      innerWidth: win.innerWidth,
      open: doc.querySelector("#resources-panel")!.open,
      summaryHidden: win.getComputedStyle(
        doc.querySelector("#resources-panel > summary"),
      ).display === "none",
      documentWidth: doc.documentElement.scrollWidth,
    };
  });
}

// Scrolls the explorer list to its end and reports whether the Refresh button
// is still inside the visible part of the scroll area.
function scrollExplorerToEnd(page: Page): Promise<boolean> {
  return evaluate(page, () => {
    const doc = (globalThis as unknown as {
      document: {
        querySelector(selector: string): {
          scrollTop: number;
          scrollHeight: number;
          getBoundingClientRect(): Box;
        } | null;
      };
    }).document;
    const area = doc.querySelector("#resources")!;
    area.scrollTop = area.scrollHeight;
    const button = doc.querySelector(
      '#resources [data-action="refresh-resources"]',
    )!.getBoundingClientRect();
    const box = area.getBoundingClientRect();
    return button.top >= box.top - 1 && button.bottom <= box.bottom + 1 &&
      area.scrollTop > 0;
  });
}

function scrollPageToTop(page: Page) {
  return evaluate(
    page,
    () =>
      (globalThis as unknown as { scrollTo(x: number, y: number): void })
        .scrollTo(0, 0),
  );
}

Deno.test({
  name:
    "The explorer is a sidebar on wide screens and a bounded panel on narrow ones",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = await NonRProducerHarness.start({
      capabilities: { resources: true },
    });
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    const shotDir = Deno.env.get("JDV_TEST_SCREENSHOT_DIR");
    try {
      owned = await launch();
      await phase("resource explorer layout test body", async () => {
        page = await owned!.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(harness.url, { waitUntil: "load" });
        await waitForLabels(page, (value) => value.length === 2, "the root");
        await clickButton(page, "Expand main", "#resources .resource-row");
        await waitForLabels(
          page,
          (value) => value.includes("public"),
          "the catalog",
        );
        await clickButton(
          page,
          "Expand public",
          "#resources .resource-row",
          0,
          "public",
        );
        await waitForLabels(
          page,
          (value) => value.includes("table_000"),
          "the table page",
        );
        await clickButton(
          page,
          "Open",
          "#resources .resource-row",
          0,
          "table_000",
        );
        await waitForSelector(page, '.tabulator-row [tabulator-field="c0"]');

        const wide = await layout(page);
        assert(wide.summaryHidden, "The sidebar has no summary.");
        assert(wide.open);
        assert(wide.panel.right <= wide.viewer.left, "Sidebar is at the left.");
        assert(wide.panel.right - wide.panel.left < 400, "Sidebar is narrow.");
        assert(
          wide.panel.bottom - wide.panel.top <= wide.innerHeight,
          "The sidebar fits the viewport.",
        );
        assert(wide.explorerScrolls, "Many rows scroll inside the sidebar.");
        assertEquals(wide.documentWidth <= wide.innerWidth, true);
        // More rows do not move the viewer.
        await clickButton(page, "Load more", "#resources .resource-more");
        await waitForLabels(
          page,
          (value) => value.includes("table_249"),
          "the second page",
        );
        const after = await layout(page);
        assertEquals(after.viewer, wide.viewer);
        assertEquals(after.tables, wide.tables);
        assert(
          await scrollExplorerToEnd(page),
          "The controls stay visible while the list is scrolled.",
        );
        if (shotDir) {
          await scrollPageToTop(page);
          await Deno.writeFile(
            `${shotDir}/explorer-wide.png`,
            await page.screenshot(),
          );
        }

        await page.setViewportSize({ width: 700, height: 900 });
        const narrow = await layout(page);
        assert(!narrow.summaryHidden, "The panel has a summary.");
        assert(narrow.open);
        assert(narrow.panel.bottom <= narrow.tables.top, "Panel is above.");
        assert(
          narrow.explorer.bottom - narrow.explorer.top <= 900 * 0.4 + 1,
          "The panel height is limited.",
        );
        assert(narrow.explorerScrolls);
        assertEquals(narrow.documentWidth <= narrow.innerWidth, true);
        assert(
          await scrollExplorerToEnd(page),
          "The panel controls stay visible while the list is scrolled.",
        );
        if (shotDir) {
          await scrollPageToTop(page);
          await Deno.writeFile(
            `${shotDir}/explorer-narrow.png`,
            await page.screenshot(),
          );
        }
        // It folds on narrow screens and opens again when the window widens.
        await click(page, "#resources-panel > summary");
        await waitFor(
          page,
          () =>
            (globalThis as unknown as {
              document: {
                querySelector(selector: string): { open: boolean } | null;
              };
            }).document.querySelector("#resources-panel")?.open === false,
        );
        await page.setViewportSize({ width: 1280, height: 720 });
        await waitFor(
          page,
          () =>
            (globalThis as unknown as {
              document: {
                querySelector(selector: string): { open: boolean } | null;
              };
            }).document.querySelector("#resources-panel")?.open === true,
        );
      });
      assertEquals(pageErrors, []);
    } finally {
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => harness.close(),
      ]);
    }
  },
});

Deno.test({
  name:
    "Resource Tree explorer subscribes first and refreshes itself on changes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = await NonRProducerHarness.start({
      capabilities: { resources: true, resource_changes: true },
    });
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    let second: Page | undefined;
    const pageErrors: string[] = [];
    const producer = harness.producer;
    try {
      owned = await launch();
      await phase("resource changes test body", async () => {
        page = await owned!.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.goto(harness.url, { waitUntil: "load" });
        await waitForLabels(
          page,
          (value) => value.length === 2,
          "the root listing",
        );
        // The subscription reaches the producer before the first listing.
        assertEquals(producer.subscribeRequests, [true]);
        const methods = producer.resourceRequests.map((request) =>
          request.method
        );
        assertEquals(methods[0], "resources/subscribe");
        assertEquals(methods[1], "resources/children");

        await clickButton(
          page,
          "Expand main",
          "#resources .resource-row",
          0,
          "main",
        );
        await waitForLabels(
          page,
          (value) => value.includes("public"),
          "the main catalog children",
        );

        // A change notice refreshes the listing and keeps the expansion.
        producer.addRootTable("auto_one");
        assert(producer.signalResourcesChanged());
        let current = await waitForLabels(
          page,
          (value) => value.includes("auto_one"),
          "the automatically refreshed root listing",
        );
        assert(current.includes("public"), "The expansion state is kept.");
        assertEquals(await count(page, '[aria-expanded="true"]'), 1);

        // A notice during a fetch lets that fetch finish and then refreshes
        // once more, so the last change is shown.
        const held: { id: string }[] = [];
        producer.onResource = (request) => {
          if (
            request.method === "resources/children" &&
            request.params.node === null && held.length === 0
          ) {
            held.push({ id: request.id });
            return true;
          }
          return false;
        };
        producer.addRootTable("auto_three");
        assert(producer.signalResourcesChanged());
        const started = Date.now();
        while (held.length === 0 && Date.now() - started < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assertEquals(held.length, 1);
        // Changed again while the first refresh is still running.
        producer.addRootTable("auto_four");
        assert(producer.signalResourcesChanged());
        await new Promise((resolve) => setTimeout(resolve, 200));
        const rootRequests = () =>
          producer.resourceRequests.filter((request) =>
            request.method === "resources/children" &&
            request.params.node === null
          ).length;
        const before = rootRequests();
        // The answer reflects the list from before the second change.
        await producer.respond(held[0].id, {
          node: null,
          offset: 0,
          children: [{
            id: "t:auto_three",
            label: "auto_three",
            kind: "table",
            has_children: false,
            viewable: true,
          }],
          total_children: 1,
          next_offset: null,
        });
        current = await waitForLabels(
          page,
          (value) => value.includes("auto_four"),
          "the trailing refresh",
        );
        assertEquals(rootRequests(), before + 1);
        assert(current.includes("auto_three"));
        producer.onResource = undefined;

        // A second tab lists the tree and is updated by the same producer
        // subscription.
        second = await owned!.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(second, pageErrors);
        await second.goto(harness.url, { waitUntil: "load" });
        await waitForLabels(
          second,
          (value) => value.includes("auto_four"),
          "the second tab's listing",
        );
        producer.addRootTable("auto_five");
        assert(producer.signalResourcesChanged());
        await waitForLabels(
          page,
          (value) => value.includes("auto_five"),
          "the first tab's update",
        );
        await waitForLabels(
          second,
          (value) => value.includes("auto_five"),
          "the second tab's update",
        );
        assertEquals(producer.subscribeRequests, [true]);
      });
      assertEquals(pageErrors, []);
    } finally {
      producer.onResource = undefined;
      await finishIntegrationCleanup([
        () => second?.close(),
        () => page?.close(),
        () => owned?.close(),
        () => harness.close(),
      ]);
    }
  },
});

Deno.test({
  name: "Resource Tree explorer keeps working when the subscription is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = await NonRProducerHarness.start({
      capabilities: { resources: true, resource_changes: true },
    });
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    const pageErrors: string[] = [];
    const producer = harness.producer;
    try {
      producer.onResource = async (request) => {
        if (request.method !== "resources/subscribe") return false;
        await producer.respond(request.id, undefined, {
          code: "internal_error",
          message: "no subscriptions today",
        });
        return true;
      };
      owned = await launch();
      await phase("refused subscription test body", async () => {
        page = await owned!.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.goto(harness.url, { waitUntil: "load" });
        await waitForLabels(
          page,
          (value) => value.length === 2,
          "the root listing",
        );
        assert(
          (await texts(page, "#resources .resource-explorer p.muted"))
            .some((value) => value.includes("Automatic updates")),
          "The refused subscription is noted.",
        );
        // The manual Refresh still works, and the subscription is not retried.
        producer.addRootTable("manual_only");
        await clickButton(page, "Refresh", "#resources .resource-explorer");
        await waitForLabels(
          page,
          (value) => value.includes("manual_only"),
          "the manually refreshed listing",
        );
        assertEquals(
          producer.resourceRequests.filter((request) =>
            request.method === "resources/subscribe"
          ).length,
          1,
        );
      });
      assertEquals(pageErrors, []);
    } finally {
      producer.onResource = undefined;
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => harness.close(),
      ]);
    }
  },
});
