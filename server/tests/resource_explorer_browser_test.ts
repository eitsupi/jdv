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
        await click(page, '#tables [data-action="close-view"]');
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
