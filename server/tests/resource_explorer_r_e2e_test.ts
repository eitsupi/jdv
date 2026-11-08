import type { Page } from "@astral/astral";
import { join } from "node:path";
import { assert, assertEquals } from "./assert.ts";
import { ArfSession } from "./helpers/arf_session.ts";
import { TestServer } from "./helpers/test_server.ts";
import { bodyDeadline, launchOwnedBrowser, phase } from "./bounded_browser.ts";
import {
  finishIntegrationCleanup,
  removeCacheDirectory,
} from "./integration_cleanup.ts";
import {
  click,
  clickButton,
  collectPageErrors,
  count,
  evaluate,
  texts,
} from "./astral_page.ts";

const testLibrary = Deno.env.get("JDV_TEST_R_LIB");
const browserExecutable = Deno.env.get("JDV_TEST_BROWSER");
const browserLibraryPath = Deno.env.get("JDV_TEST_BROWSER_LIBS");

type BrowserDocument = {
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): { textContent: string | null }[];
};

let rEvaluationSequence = 0;

function rEval(arf: ArfSession, code: string, timeoutMs = 30_000) {
  const sequence = ++rEvaluationSequence;
  return phase(
    `Resource explorer R evaluation ${sequence}`,
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

function rQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const labels = (page: Page) => texts(page, "#resources .resource-label");

async function waitForLabels(
  page: Page,
  predicate: (labels: string[]) => boolean,
  description: string,
): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await labels(page);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${description}; saw ${JSON.stringify(last)}`,
  );
}

async function waitForText(
  page: Page,
  selector: string,
  predicate: (value: string) => boolean,
  description: string,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    last = (await evaluate(
      page,
      (selector: string) =>
        (globalThis as unknown as { document: BrowserDocument }).document
          .querySelector(selector)?.textContent ?? "",
      { args: [selector] },
    )) as string;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${description}; saw ${JSON.stringify(last)}`,
  );
}

function launch() {
  return launchOwnedBrowser({
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
}

interface Runtime {
  server: TestServer;
  arf: ArfSession;
}

async function startRuntime(setup: string): Promise<Runtime> {
  assert(testLibrary, "JDV_TEST_R_LIB must select the scratch library.");
  const server = new TestServer();
  const arf = new ArfSession();
  try {
    await phase(
      "Resource explorer server startup",
      () => server.start(),
      30_000,
    );
    await phase(
      "Resource explorer arf startup",
      () => arf.start({ env: server.rEnv(testLibrary) }),
      60_000,
    );
    const libraryPath = rQuote(testLibrary);
    await rEval(
      arf,
      `.libPaths(c(${libraryPath}, .libPaths())); ` +
        `library(jdv, lib.loc = ${libraryPath}); ${setup}`,
    );
    return { server, arf };
  } catch (error) {
    await finishIntegrationCleanup([
      () => arf.close(),
      () => server.close(),
    ], [error]);
    throw error;
  }
}

Deno.test({
  name:
    "real R resource explorer lists, opens, refreshes, and follows global variables",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let runtime: Runtime | undefined;
    let directory: string | undefined;
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    let second: Page | undefined;
    let primaryError: unknown;
    const pageErrors: string[] = [];
    try {
      await bodyDeadline("Resource explorer R E2E body", async () => {
        directory = await Deno.makeTempDir({ prefix: "jdv-resources-" });
        const promiseMarker = join(directory, "promise-forced");
        const activeMarker = join(directory, "active-read");
        // Nothing may be forced while the explorer lists the session.
        const setup = [
          "df_cars <- mtcars[1:5, ]",
          "list_nested <- list(alpha = 1, beta = list(gamma = 2))",
          "to_remove <- 1",
          ".hidden_value <- 42",
          `delayedAssign("lazy_promise", {` +
          `cat("forced\\n", file = ${rQuote(promiseMarker)}); 1})`,
          `makeActiveBinding("active_binding", function() {` +
          `cat("read\\n", file = ${rQuote(activeMarker)}); 1}, globalenv())`,
        ].join("; ");
        runtime = await startRuntime(setup);
        const { server, arf } = runtime;
        const trackable = (await rEval(
          arf,
          'cat(getRversion() >= "4.6.0")',
        )).stdout?.includes("TRUE") === true;

        owned = await launch();
        page = await phase(
          "Resource explorer new page",
          () => owned!.browser.newPage("about:blank", { waitUntil: "none" }),
          20_000,
        );
        collectPageErrors(page, pageErrors);
        await page.goto(server.url, { waitUntil: "load" });
        assertEquals(await count(page, "#resources .resource-explorer"), 0);

        // Connecting is enough: no view has been opened yet.
        await rEval(arf, "jdv_connect()");
        let current = await waitForLabels(
          page,
          (value) => value.includes("df_cars"),
          "the global environment listing",
        );
        assertEquals(await count(page, "#tables article"), 0);
        for (
          const name of [
            "df_cars",
            "list_nested",
            "to_remove",
            "lazy_promise",
            "active_binding",
          ]
        ) {
          assert(current.includes(name), `Missing ${name} in ${current}`);
        }
        // Names are ordered by their bytes.
        assertEquals([...current], [...current].sort());

        // Hidden variables are filtered until asked for.
        assert(!current.includes(".hidden_value"));
        await click(page, '[data-action="toggle-hidden"]');
        current = await waitForLabels(
          page,
          (value) => value.includes(".hidden_value"),
          "the hidden variable",
        );
        await click(page, '[data-action="toggle-hidden"]');
        current = await waitForLabels(
          page,
          (value) => !value.includes(".hidden_value"),
          "the hidden variable to disappear",
        );

        // A second client sees the same listing.
        second = await owned.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(second, pageErrors);
        await second.goto(server.url, { waitUntil: "load" });
        const other = await waitForLabels(
          second,
          (value) => value.includes("df_cars"),
          "the listing in a second client",
        );
        assertEquals(other, current);
        await second.close();
        second = undefined;
        await page.bringToFront();

        // A data.frame opens as a grid and a list as a tree; the title is the
        // variable name.
        await clickButton(
          page,
          "Open",
          "#resources .resource-row",
          0,
          "df_cars",
        );
        await waitForText(
          page,
          "#table-title",
          (value) => value === "df_cars",
          "the grid title",
        );
        await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
        await clickButton(
          page,
          "Open",
          "#resources .resource-row",
          0,
          "list_nested",
        );
        await waitForText(
          page,
          "#tree-title",
          (value) => value === "list_nested",
          "the tree title",
        );
        await page.waitForSelector("#tree-viewer:not([hidden])");
        assertEquals(await count(page, "#tables article"), 2);

        // Refresh picks up added and removed variables and keeps both views.
        await rEval(arf, 'added_var <- "new"; rm(to_remove)');
        await clickButton(page, "Refresh", "#resources .resource-explorer");
        current = await waitForLabels(
          page,
          (value) =>
            value.includes("added_var") && !value.includes("to_remove"),
          "the refreshed listing",
        );
        assertEquals(await count(page, "#tables article"), 2);

        // The grid view follows reassignments of its variable.
        if (trackable) {
          await clickButton(
            page,
            "Open view",
            "#tables article",
            0,
            "df_cars",
          );
          await waitForText(
            page,
            "#table-meta",
            (value) => value.includes("5 rows"),
            "the initial row count",
          );
          // A visible evaluation runs through R's REPL, so the tracking task
          // callback fires after it.
          await rEvalVisible(arf, "df_cars <- mtcars[1:9, ]");
          await waitForText(
            page,
            "#table-meta",
            (value) => value.includes("9 rows"),
            "the tracked row count",
          );
          assertEquals(await count(page, "#tables article"), 2);
        } else {
          console.log("Skipping variable tracking: R is older than 4.6.0.");
        }

        // Neither listing nor refreshing forced the promise or the binding.
        await clickButton(page, "Refresh", "#resources .resource-explorer");
        await waitForLabels(
          page,
          (value) => value.includes("lazy_promise"),
          "the listing after another refresh",
        );
        for (const marker of [promiseMarker, activeMarker]) {
          assert(
            !(await Deno.stat(marker).then(() => true, () => false)),
            `${marker} was created by listing the environment.`,
          );
        }
        assertEquals(pageErrors, []);
      }, 240_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => second?.close(),
        () => page?.close(),
        () => owned?.close(),
        () => runtime?.arf.close(),
        () => runtime?.server.close(),
        ...(directory ? [() => removeCacheDirectory(directory!)] : []),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

/** The text of the explorer row of one variable, or null when it is absent. */
function rowText(page: Page, name: string): Promise<string | null> {
  return evaluate(
    page,
    (name: string) => {
      const doc = (globalThis as unknown as {
        document: {
          querySelectorAll(selector: string): {
            textContent: string | null;
            querySelector(selector: string): {
              textContent: string | null;
            } | null;
          }[];
        };
      }).document;
      for (const row of doc.querySelectorAll("#resources .resource-row")) {
        if (row.querySelector(".resource-label")?.textContent === name) {
          return row.textContent ?? "";
        }
      }
      return null;
    },
    { args: [name] },
  ) as Promise<string | null>;
}

async function waitForRow(
  page: Page,
  name: string,
  predicate: (text: string | null) => boolean,
  description: string,
): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await rowText(page, name);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${description}; saw ${JSON.stringify(last)}`,
  );
}

Deno.test({
  name: "real R resource explorer updates itself after top-level commands",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let runtime: Runtime | undefined;
    let directory: string | undefined;
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    let primaryError: unknown;
    const pageErrors: string[] = [];
    try {
      await bodyDeadline("Resource explorer auto update E2E body", async () => {
        directory = await Deno.makeTempDir({ prefix: "jdv-resources-auto-" });
        const promiseMarker = join(directory, "promise-forced");
        const activeMarker = join(directory, "active-read");
        const setup = [
          "auto_df <- mtcars[1:5, ]",
          "auto_gone <- 1",
          "auto_same <- 1",
          "auto_class <- 1",
          ".auto_hidden <- 1",
          `delayedAssign("auto_promise", {` +
          `cat("forced\\n", file = ${rQuote(promiseMarker)}); 1})`,
          `makeActiveBinding("auto_active", function() {` +
          `cat("read\\n", file = ${rQuote(activeMarker)}); 1}, globalenv())`,
        ].join("; ");
        runtime = await startRuntime(setup);
        const { server, arf } = runtime;

        owned = await launch();
        page = await owned.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.goto(server.url, { waitUntil: "load" });
        await rEval(arf, "jdv_connect()");
        await waitForLabels(
          page,
          (value) => value.includes("auto_df"),
          "the initial listing",
        );
        // Wait until the explorer's subscription has reached R.
        const subscribeDeadline = Date.now() + 20_000;
        for (;;) {
          const state = await rEval(
            arf,
            "cat(isTRUE(jdv:::.jdv_state$res_subscribed))",
          );
          if (state.stdout?.includes("TRUE")) break;
          assert(
            Date.now() < subscribeDeadline,
            "The explorer never subscribed to changes.",
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Open a view and the hidden toggle: both must survive updates.
        await clickButton(
          page,
          "Open",
          "#resources .resource-row",
          0,
          "auto_df",
        );
        await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
        await click(page, '[data-action="toggle-hidden"]');
        await waitForLabels(
          page,
          (value) => value.includes(".auto_hidden"),
          "the hidden variable",
        );
        const views = await count(page, "#tables article");
        assert(views >= 1);

        // Additions and removals appear without pressing Refresh.
        await rEvalVisible(arf, "auto_added <- 'x'; rm(auto_gone)");
        await waitForLabels(
          page,
          (value) =>
            value.includes("auto_added") && !value.includes("auto_gone"),
          "the automatic update",
        );
        assertEquals(await count(page, "#tables article"), views);
        assertEquals(await count(page, "#viewer:not([hidden])"), 1);
        assert((await labels(page)).includes(".auto_hidden"));

        // A class change updates the row.
        const before = await rowText(page, "auto_class");
        await rEvalVisible(arf, "auto_class <- mtcars[1:2, ]");
        await waitForRow(
          page,
          "auto_class",
          (value) => value !== null && value !== before,
          "the changed row",
        );

        // A reassignment that lists the same must not break anything.
        await rEvalVisible(arf, "auto_same <- 2");
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert((await labels(page)).includes("auto_same"));

        // A silent evaluation does not run the task callback, but an explicit
        // observation reports it.
        await rEval(arf, "auto_silent <- 1");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await rEval(arf, "jdv_rpc(NULL)");
        await waitForLabels(
          page,
          (value) => value.includes("auto_silent"),
          "the silent change after an explicit observation",
        );

        // Neither watching nor listing evaluated the promise or the binding.
        for (const marker of [promiseMarker, activeMarker]) {
          assert(
            !(await Deno.stat(marker).then(() => true, () => false)),
            `${marker} was created by watching the environment.`,
          );
        }
        assertEquals(await count(page, "#viewer:not([hidden])"), 1);
        assertEquals(pageErrors, []);
      }, 240_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => runtime?.arf.close(),
        () => runtime?.server.close(),
        ...(directory ? [() => removeCacheDirectory(directory!)] : []),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});

Deno.test({
  name: "real R session with jdv.resources = FALSE has no explorer",
  ignore: !testLibrary,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let runtime: Runtime | undefined;
    let owned: Awaited<ReturnType<typeof launch>> | undefined;
    let page: Page | undefined;
    let primaryError: unknown;
    const pageErrors: string[] = [];
    try {
      await bodyDeadline("Resource explorer disabled E2E body", async () => {
        runtime = await startRuntime(
          "options(jdv.resources = FALSE); jdv_connect(); " +
            'plain_df <- mtcars[1:3, ]; jdv_view(plain_df, title = "plain")',
        );
        owned = await launch();
        page = await owned.browser.newPage("about:blank", {
          waitUntil: "none",
        });
        collectPageErrors(page, pageErrors);
        await page.goto(runtime.server.url, { waitUntil: "load" });
        await waitForText(
          page,
          "#tables",
          (value) => value.includes("plain"),
          "the view list",
        );
        await clickButton(page, "Open view", "#tables article", 0, "plain");
        await waitForText(
          page,
          "#table-title",
          (value) => value === "plain",
          "the plain view title",
        );
        await page.waitForSelector("#viewer:not([hidden]) .tabulator-row");
        assertEquals(await count(page, "#resources .resource-explorer"), 0);
        // Nothing subscribes to changes.
        const state = await rEval(
          runtime.arf,
          "cat(isTRUE(jdv:::.jdv_state$res_subscribed))",
        );
        assert(
          state.stdout?.includes("FALSE") === true,
          `Unexpected state ${state.stdout}`,
        );
        assertEquals(pageErrors, []);
      }, 120_000);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await finishIntegrationCleanup([
        () => page?.close(),
        () => owned?.close(),
        () => runtime?.arf.close(),
        () => runtime?.server.close(),
      ], primaryError === undefined ? [] : [primaryError]);
    }
  },
});
