// Built-in `browser` tool (§5.4).
//
// Controls a headless Chromium browser via Puppeteer to allow the agent to
// open web pages, interact with elements, take screenshots, and execute
// arbitrary JavaScript in the page context.
//
// Puppeteer is an optional dependency — if it is not installed the tool
// returns a clear error message instructing the user to install it.
//
// Operations:
//   open(url?)       — Open a new browser tab (or create a new browser instance).
//   click(selector)  — Click the first element matching the CSS selector.
//   type(selector, text) — Type text into the element matching the selector.
//   screenshot()     — Take a screenshot of the current page (returns base64).
//   evaluate(code)   — Execute arbitrary JavaScript in the page context.
//
// Conventions: data + functions, no class, no this.

import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Module-level state
//
// We keep a singleton browser instance plus the current page. The same
// browser is reused across tool calls so the session is persistent.
// ---------------------------------------------------------------------------

type BrowserPages = {
  browser: unknown; // Puppeteer Browser
  page: unknown; // Puppeteer Page
};

let browserPages: BrowserPages | null = null;
let puppeteerModule: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Dynamic puppeteer import — optional dependency
// ---------------------------------------------------------------------------

async function loadPuppeteer(): Promise<Record<string, unknown>> {
  if (puppeteerModule !== null) {
    return puppeteerModule;
  }
  try {
    // Dynamic import so puppeteer is truly optional
    // @ts-expect-error - puppeteer is optional; error expected when not installed
    puppeteerModule = await import("puppeteer");
    return puppeteerModule!;
  } catch {
    throw new Error(
      "puppeteer is not installed. Run: npm install puppeteer  or  bun add puppeteer",
    );
  }
}

// ---------------------------------------------------------------------------
// Browser lifecycle helpers
// ---------------------------------------------------------------------------

async function getOrCreateBrowser(): Promise<BrowserPages> {
  if (browserPages !== null) {
    return browserPages;
  }

  const puppeteer = await loadPuppeteer();
  const browser = await (
    puppeteer.launch as (opts: Record<string, unknown>) => Promise<Record<string, unknown>>
  )({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const page = await (browser as { newPage: () => Promise<unknown> }).newPage();
  await (page as { setViewport: (o: Record<string, unknown>) => Promise<void> }).setViewport({
    width: 1280,
    height: 800,
  });

  browserPages = { browser, page } as BrowserPages;
  return browserPages!;
}

async function closeBrowser(): Promise<void> {
  if (browserPages === null) return;
  try {
    const bp = browserPages;
    browserPages = null;
    await ((bp.browser as Record<string, unknown>).close as () => Promise<void>)();
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Implementation functions
// ---------------------------------------------------------------------------

async function browserOpen(url: string | undefined, signal: AbortSignal): Promise<ToolResult> {
  const bp = await getOrCreateBrowser();

  // If the page already navigated somewhere and we just want a new tab,
  // create a new page. Otherwise reuse the current one.
  const page = bp.page as { url: () => string };
  const currentUrl = page.url();

  let targetPage: Record<string, unknown>;
  if (url && currentUrl !== "about:blank") {
    targetPage = await (
      bp.browser as { newPage: () => Promise<Record<string, unknown>> }
    ).newPage();
    (browserPages as BrowserPages).page = targetPage as unknown as BrowserPages["page"];
  } else {
    targetPage = bp.page as Record<string, unknown>;
  }

  if (url) {
    const gotoFn = targetPage.goto as (u: string, opts: Record<string, unknown>) => Promise<void>;
    await gotoFn.call(targetPage, url, { waitUntil: "networkidle0", signal });
  }

  const title = await (targetPage.title as () => Promise<string>).call(targetPage);
  return ok(
    url
      ? `Opened ${url}\nPage title: ${title}`
      : "Browser is ready (no URL provided). Use click/type/screenshot/evaluate to interact.",
    { url: url ?? null, title },
  );
}

async function browserClick(selector: string, signal: AbortSignal): Promise<ToolResult> {
  if (browserPages === null) {
    return err('browser: no page open. Call "open" first with a URL.');
  }
  const page = browserPages.page as Record<string, unknown>;
  try {
    await (page.waitForSelector as (s: string, o: Record<string, unknown>) => Promise<void>).call(
      page,
      selector,
      { timeout: 5000, signal },
    );
    await (page.click as (s: string) => Promise<void>).call(page, selector);
    return ok(`Clicked: ${selector}`);
  } catch (error) {
    return err(`browser click failed: ${(error as Error).message}`);
  }
}

async function browserType(
  selector: string,
  text: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (browserPages === null) {
    return err('browser: no page open. Call "open" first with a URL.');
  }
  const page = browserPages.page as Record<string, unknown>;
  try {
    await (page.waitForSelector as (s: string, o: Record<string, unknown>) => Promise<void>).call(
      page,
      selector,
      { timeout: 5000, signal },
    );
    await (page.click as (s: string) => Promise<void>).call(page, selector);
    await (page.type as (s: string, t: string) => Promise<void>).call(page, selector, text);
    return ok(`Typed "${text}" into: ${selector}`);
  } catch (error) {
    return err(`browser type failed: ${(error as Error).message}`);
  }
}

async function browserScreenshot(_signal: AbortSignal): Promise<ToolResult> {
  if (browserPages === null) {
    return err('browser: no page open. Call "open" first with a URL.');
  }
  const page = browserPages.page as Record<string, unknown>;
  try {
    const screenshotFn = page.screenshot as (o: Record<string, unknown>) => Promise<string>;
    const dataUrl = await screenshotFn.call(page, {
      type: "png",
      encoding: "base64",
      fullPage: false,
    });
    return ok(`data:image/png;base64,${dataUrl}`, { mimeType: "image/png", encoding: "base64" });
  } catch (error) {
    return err(`browser screenshot failed: ${(error as Error).message}`);
  }
}

async function browserEvaluate(code: string, _signal: AbortSignal): Promise<ToolResult> {
  if (browserPages === null) {
    return err('browser: no page open. Call "open" first with a URL.');
  }
  const page = browserPages.page as Record<string, unknown>;
  try {
    const evaluateFn = page.evaluate as (c: string) => Promise<unknown>;
    const result = await evaluateFn.call(page, code);
    return ok(typeof result === "string" ? result : JSON.stringify(result, null, 2), { result });
  } catch (error) {
    return err(`browser evaluate failed: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// browserTool — ToolDef
// ---------------------------------------------------------------------------

export const browserTool: ToolDef = {
  name: "browser",
  description:
    "Control a headless browser (Chromium via Puppeteer). Supports opening URLs, clicking elements, " +
    "typing text, taking screenshots, and evaluating JavaScript in the page context. " +
    "Puppeteer is an optional dependency — install it with: npm install puppeteer",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          'The browser action to perform. One of: "open" (navigate to a URL), ' +
          '"click" (click an element by CSS selector), "type" (type text into an element), ' +
          '"screenshot" (capture the current page), "evaluate" (execute JS in page context).',
        enum: ["open", "click", "type", "screenshot", "evaluate"],
      },
      url: {
        type: "string",
        description:
          'URL to open (only used with action="open"). If omitted, just ensures a browser tab exists.',
      },
      selector: {
        type: "string",
        description:
          'CSS selector for the target element (used with action="click" or action="type").',
      },
      text: {
        type: "string",
        description: 'Text to type into the element (only used with action="type").',
      },
      code: {
        type: "string",
        description: 'JavaScript code to evaluate in the page (only used with action="evaluate").',
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  permission: "ask",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const action = typeof args.action === "string" ? args.action.trim() : "";

    if (action.length === 0) {
      return err(
        'browser: "action" argument is required (one of: open, click, type, screenshot, evaluate)',
      );
    }

    try {
      switch (action) {
        case "open": {
          const url = typeof args.url === "string" ? args.url : undefined;
          return await browserOpen(url, context.abort);
        }
        case "click": {
          const selector = typeof args.selector === "string" ? args.selector.trim() : "";
          if (selector.length === 0) {
            return err('browser: "selector" argument is required for click action');
          }
          return await browserClick(selector, context.abort);
        }
        case "type": {
          const selector = typeof args.selector === "string" ? args.selector.trim() : "";
          const text = typeof args.text === "string" ? args.text : "";
          if (selector.length === 0) {
            return err('browser: "selector" argument is required for type action');
          }
          return await browserType(selector, text, context.abort);
        }
        case "screenshot":
          return await browserScreenshot(context.abort);
        case "evaluate": {
          const code = typeof args.code === "string" ? args.code.trim() : "";
          if (code.length === 0) {
            return err('browser: "code" argument is required for evaluate action');
          }
          return await browserEvaluate(code, context.abort);
        }
        default:
          return err(
            `browser: unknown action "${action}". Valid actions: open, click, type, screenshot, evaluate`,
          );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return err("browser: aborted");
      }
      return err(`browser: ${(error as Error).message}`);
    }
  },
};
