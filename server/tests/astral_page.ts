import type { ElementHandle, Page, PageErrorEvent } from "@astral/astral";
import { cleanupDeadline } from "./integration_cleanup.ts";

// Browser-only globals are scoped here so their types do not alter Deno tests.
interface Element {
  textContent: string | null;
  value: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: Element | null): boolean;
  setAttribute(name: string, value: string): void;
  querySelectorAll(selector: string): Element[];
  scrollIntoView(options: { block: string; inline: string }): void;
  dispatchEvent(event: Event): boolean;
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}
type HTMLInputElement = Element;
declare const document: {
  querySelector(selector: string): Element | null;
  elementFromPoint(x: number, y: number): Element | null;
  querySelectorAll(selector: string): Element[];
};
declare const innerWidth: number;
declare const innerHeight: number;
declare function requestAnimationFrame(callback: () => void): number;
declare function getComputedStyle(element: Element): { display: string };

export function operation<T>(
  label: string,
  run: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  return cleanupDeadline(
    run(),
    timeoutMs,
    `Astral operation timed out: ${label}`,
  );
}

export function evaluate<T, A extends unknown[]>(
  page: Page,
  fn: (...args: A) => T,
  options?: { args: Readonly<A> },
): Promise<T> {
  return operation("page evaluate", () => page.evaluate(fn, options));
}

export function waitForSelector(
  page: Page,
  selector: string,
  options: { timeout?: number } = {},
) {
  return operation(
    `selector ${selector}`,
    () => page.waitForSelector(selector, options),
    options.timeout ?? 15_000,
  );
}

export async function waitFor<T, A>(
  page: Page,
  predicate: (arg: A) => T,
  arg?: A,
  options: { timeout?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? 15_000);
  while (Date.now() < deadline) {
    const value = await operation(
      "predicate evaluation",
      () => page.evaluate(predicate, { args: [arg as A] }),
      Math.max(1, Math.min(10_000, deadline - Date.now())),
    );
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Browser condition timed out: ${predicate.toString().slice(0, 160)}`,
  );
}

export async function element(
  page: Page,
  selector: string,
  index = 0,
): Promise<ElementHandle> {
  await waitForSelector(page, selector);
  const elements = await operation(
    `query ${selector}`,
    () => page.$$(selector),
  );
  const handle = elements[index < 0 ? elements.length + index : index];
  if (!handle) throw new Error(`No element ${index} for ${selector}`);
  return handle;
}
export async function click(page: Page, selector: string, index = 0) {
  await operation(`pointer click ${selector}`, async () => {
    await page.bringToFront();
    await (await element(page, selector, index)).scrollIntoView();
    // Scrolling virtualized columns can replace the original ElementHandle.
    // Resolve fresh geometry and dispatch exactly one physical click.
    const point = await waitFor(
      page,
      async (args: { selector: string; index: number }) => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
        const elements = document.querySelectorAll(args.selector);
        const target =
          elements[args.index < 0 ? elements.length + args.index : args.index];
        let rect = target?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        if (
          rect.left < 0 || rect.top < 0 ||
          rect.left + rect.width > innerWidth ||
          rect.top + rect.height > innerHeight
        ) {
          target.scrollIntoView({ block: "center", inline: "center" });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          );
          const fresh = document.querySelectorAll(args.selector);
          rect = fresh[args.index < 0 ? fresh.length + args.index : args.index]
            ?.getBoundingClientRect();
          if (!rect) return null;
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return null;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
        const settled = document.querySelectorAll(args.selector);
        const current =
          settled[args.index < 0 ? settled.length + args.index : args.index];
        const currentRect = current?.getBoundingClientRect();
        if (
          !currentRect || currentRect.left !== rect.left ||
          currentRect.top !== rect.top || currentRect.width !== rect.width ||
          currentRect.height !== rect.height ||
          !current.contains(document.elementFromPoint(x, y))
        ) return null;
        return { x, y };
      },
      { selector, index },
      { timeout: 5_000 },
    );
    if (!point) throw new Error(`No visible click point for ${selector}`);
    await page.mouse.click(point.x, point.y);
  });
}
export async function evaluateElement<E, R>(
  page: Page,
  selector: string,
  fn: (element: E) => R,
  index = 0,
): Promise<R> {
  const handle = await element(page, selector, index);
  return await operation(
    `element evaluate ${selector}`,
    () => handle.evaluate(fn),
  );
}
export async function evaluateElements<E, R>(
  page: Page,
  selector: string,
  fn: (elements: E[]) => R,
): Promise<R> {
  return await operation(`elements evaluate ${selector}`, () =>
    page.evaluate(
      `(${fn.toString()})(Array.from(document.querySelectorAll(${
        JSON.stringify(selector)
      })))`,
    ));
}
export function text(page: Page, selector: string, index = 0) {
  return evaluateElement(
    page,
    selector,
    (el: { textContent: string | null }) => el.textContent,
    index,
  );
}
export function count(page: Page, selector: string) {
  return evaluate(
    page,
    (selector) => document.querySelectorAll(selector).length,
    { args: [selector] },
  );
}
export function texts(page: Page, selector: string) {
  return evaluateElements(
    page,
    selector,
    (elements: { textContent: string | null }[]) =>
      elements.map((el) => el.textContent ?? ""),
  );
}
export function inputValue(page: Page, selector: string) {
  return evaluateElement(page, selector, (el: { value: string }) => el.value);
}
export function isHidden(page: Page, selector: string) {
  return evaluateElement(
    page,
    selector,
    (el: Element) =>
      el.hasAttribute("hidden") || getComputedStyle(el).display === "none",
  );
}
export function isDisabled(page: Page, selector: string) {
  return evaluateElement(
    page,
    selector,
    (el: { disabled: boolean }) => el.disabled,
  );
}
export function fillInput(page: Page, selector: string, value: string) {
  return evaluate(page, (selector, value) => {
    const el = document.querySelector(selector) as HTMLInputElement;
    if (!el) throw new Error(`Missing input ${selector}`);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, { args: [selector, value] });
}
export async function selectOption(
  page: Page,
  selector: string,
  value: string,
) {
  await fillInput(page, selector, value);
  await evaluate(page, (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Missing select ${selector}`);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { args: [selector] });
}

// Locate by visible button text, then use Astral's physical pointer click.
export async function button(
  page: Page,
  label: string,
  scope = "body",
  scopeIndex = 0,
  scopeText?: string,
) {
  const marker = crypto.randomUUID();
  await waitFor(
    page,
    (
      args: {
        label: string;
        scope: string;
        scopeIndex: number;
        scopeText?: string;
        marker: string;
      },
    ) => {
      const roots = Array.from(document.querySelectorAll(args.scope)).filter((
        el,
      ) =>
        args.scopeText === undefined || el.textContent?.includes(args.scopeText)
      );
      const root = roots[
        args.scopeIndex < 0 ? roots.length + args.scopeIndex : args.scopeIndex
      ];
      const target = root &&
        Array.from(root.querySelectorAll("button")).find((el) =>
          (el.getAttribute("aria-label") ?? el.textContent)?.trim() ===
            args.label
        );
      if (!target) return false;
      target.setAttribute("data-jdv-test-button", args.marker);
      return true;
    },
    { label, scope, scopeIndex, scopeText, marker },
  );
  return await element(page, `[data-jdv-test-button="${marker}"]`);
}
export function collectPageErrors(page: Page, errors: string[]) {
  page.addEventListener(
    "pageerror",
    (event) => errors.push((event as PageErrorEvent).detail.message),
  );
}
export async function observeSocketFrames(
  page: Page,
  receive: (
    frame: {
      direction: "sent" | "received";
      payload: string | Uint8Array;
      requestId: string;
    },
  ) => void,
) {
  const cdp = page.unsafelyGetCelestialBindings();
  for (
    const [event, direction] of [["Network.webSocketFrameSent", "sent"], [
      "Network.webSocketFrameReceived",
      "received",
    ]] as const
  ) {
    cdp.addEventListener(event, (event) => {
      const detail = (event as CustomEvent<
        {
          requestId: string;
          response: { opcode: number; payloadData: string };
        }
      >).detail;
      if (detail.response.opcode !== 1 && detail.response.opcode !== 2) return;
      const payload = detail.response.opcode === 1
        ? detail.response.payloadData
        : Uint8Array.from(
          atob(detail.response.payloadData),
          (ch) => ch.charCodeAt(0),
        );
      receive({ direction, payload, requestId: detail.requestId });
    });
  }
  await operation("CDP network enable", () => cdp.Network.enable({}));
}
export async function closePage(page: Page) {
  const targetId = new URL(page.unsafelyGetCelestialBindings().ws.url).pathname
    .split("/").pop()!;
  await cleanupDeadline(
    page.browser().unsafelyGetCelestialBindings().Target.closeTarget({
      targetId,
    }),
    5_000,
    "Browser target close timed out.",
  );
  await cleanupDeadline(
    page.close(),
    5_000,
    "Browser page connection close timed out.",
  );
}

export async function clickButton(
  page: Page,
  label: string,
  scope = "body",
  scopeIndex = 0,
  scopeText?: string,
) {
  await operation(`button click ${label}`, async () => {
    await page.bringToFront();
    await (await button(page, label, scope, scopeIndex, scopeText))
      .scrollIntoView();
    const point = await waitFor(
      page,
      (
        args: {
          label: string;
          scope: string;
          scopeIndex: number;
          scopeText?: string;
        },
      ) => {
        const roots = Array.from(document.querySelectorAll(args.scope)).filter((
          el,
        ) =>
          args.scopeText === undefined ||
          el.textContent?.includes(args.scopeText)
        );
        const root = roots[
          args.scopeIndex < 0 ? roots.length + args.scopeIndex : args.scopeIndex
        ];
        const target = root &&
          Array.from(root.querySelectorAll("button")).find((el) =>
            (el.getAttribute("aria-label") ?? el.textContent)?.trim() ===
              args.label
          );
        if (!target) return null;
        // Scroll on every poll: content rendered later can move the button
        // out of the viewport after an earlier scroll.
        target.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
          ? { x, y }
          : null;
      },
      { label, scope, scopeIndex, scopeText },
      { timeout: 5_000 },
    );
    if (!point) throw new Error(`No visible button point for ${label}`);
    await page.mouse.click(point.x, point.y);
  });
}

export async function innerText(page: Page, selector: string, index = 0) {
  const handle = await element(page, selector, index);
  return await operation(`element text ${selector}`, () => handle.innerText());
}
export async function getAttribute(page: Page, selector: string, name: string) {
  const handle = await element(page, selector);
  return await operation(
    `attribute ${selector}`,
    () => handle.getAttribute(name),
  );
}
export function screenshot(page: Page) {
  return operation(
    "screenshot",
    () => page.screenshot({ captureBeyondViewport: true }),
  );
}
