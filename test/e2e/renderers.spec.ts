import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, test, type Page } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "../..");
const overlayFixtureCanvas = createCanvas(8, 8);
const overlayFixtureContext = overlayFixtureCanvas.getContext("2d");
overlayFixtureContext.fillStyle = "#00ff00";
overlayFixtureContext.fillRect(0, 0, 8, 8);
const overlayFixturePng = overlayFixtureCanvas.toBuffer("image/png");
let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/overlay-fixture.png") {
        response.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
        response.end(overlayFixturePng);
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <script type="importmap">
            {
              "imports": {
                "@sixtyfold/core": "/packages/core/dist/index.js",
                "@sixtyfold/core/": "/packages/core/dist/"
              }
            }
          </script>
          <body></body>`);
        return;
      }
      let resolved = path.resolve(root, url.pathname.slice(1));
      if (!resolved.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(resolved);
      } catch (error) {
        if (path.extname(resolved) || !isMissingFileError(error)) throw error;
        resolved = `${resolved}.js`;
        body = await readFile(resolved);
      }
      response.writeHead(200, {
        "content-type": contentType(resolved),
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Renderer test server did not expose a TCP port.");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

for (const renderMode of ["main", "auto", "worker"] as const) {
  test(`Line renders and responds to wheel and keyboard in ${renderMode} mode`, async ({
    page,
  }) => {
    const initial = await mountLineChart(page, renderMode);
    expect(initial.renderMode).toBe(resolveExpectedRenderMode(renderMode, initial.workerCapable));
    const canvas = page.getByRole("application", { name: "Line renderer test chart" });
    await expect(canvas).toHaveAttribute("tabindex", "0");
    await expectCanvasToContainChart(page);

    const zoomed = await zoomWithWheel(page, initial.viewport);
    expect(zoomed.xMax - zoomed.xMin).toBeLessThan(initial.viewport.xMax - initial.viewport.xMin);

    const panned = await panWithKeyboard(page, zoomed);
    expect(panned.xMin).toBeGreaterThan(zoomed.xMin);
    await destroyChart(page);
  });

  test(`Stock renders indicators and market layers in ${renderMode} mode`, async ({ page }) => {
    const initial = await mountStockChart(page, renderMode);
    expect(initial.renderMode).toBe(resolveExpectedRenderMode(renderMode, initial.workerCapable));
    const canvas = page.getByRole("application", { name: "Stock renderer test chart" });
    await expect(canvas).toHaveAttribute("tabindex", "0");
    await expectCanvasToContainChart(page);

    const zoomed = await zoomWithWheel(page, initial.viewport);
    expect(zoomed.xMax - zoomed.xMin).toBeLessThan(initial.viewport.xMax - initial.viewport.xMin);
    await destroyChart(page);
  });
}

for (const chartType of ["Line", "Stock"] as const) {
  test(`${chartType} worker redraws and stays interactive after repeated resume and resize`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const initial =
      chartType === "Line"
        ? await mountLineChart(page, "worker")
        : await mountStockChart(page, "worker");
    expect(initial.renderMode).toBe("worker");
    await expectCanvasToContainChart(page);
    expect(page.workers()).toHaveLength(1);
    const worker = page.workers()[0];
    let workerClosed = false;
    worker.on("close", () => {
      workerClosed = true;
    });

    try {
      // Observe commands after the renderer's existing synchronous handler.
      // Rendering, worker messages and browser visibility APIs stay unchanged.
      await worker.evaluate(() => {
        globalThis.__rendererResumeMessages = { invalidations: 0, resizeWidth: null };
        self.addEventListener("message", (event: MessageEvent) => {
          const messages = globalThis.__rendererResumeMessages!;
          if (event.data.type === "invalidateCache") messages.invalidations++;
          if (event.data.type === "resize") messages.resizeWidth = event.data.width;
        });
      });
      await page.evaluate(() => {
        globalThis.__rendererResume = { frames: 0, errors: [] };
        const chart = globalThis.__rendererSafetyChart!;
        chart.setRendererErrorCallback((error) => {
          globalThis.__rendererResume!.errors.push(`${error.name}: ${error.message}`);
        });
        chart.setStatsCallback(() => globalThis.__rendererResume!.frames++, { intervalMs: 0 });
        document.body.style.minHeight = "2000px";
      });

      const canvas = page.locator("#chart");
      for (const width of [880, 960]) {
        const framesBefore = await page.evaluate(() => globalThis.__rendererResume!.frames);
        const invalidationsBefore = await worker.evaluate(
          () => globalThis.__rendererResumeMessages!.invalidations,
        );
        expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
        await page.evaluate(() => {
          window.dispatchEvent(new Event("focus"));
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect
          .poll(() => worker.evaluate(() => globalThis.__rendererResumeMessages!.invalidations))
          .toBeGreaterThanOrEqual(invalidationsBefore + 2);

        await canvas.evaluate((element, width) => {
          element.style.width = `${width}px`;
        }, width);
        await expect
          .poll(() => worker.evaluate(() => globalThis.__rendererResumeMessages!.resizeWidth))
          .toBe(width);

        await page.evaluate(() => window.scrollTo(0, 1500));
        await expect(canvas).not.toBeInViewport();
        const invalidationsBeforeReentry = await worker.evaluate(
          () => globalThis.__rendererResumeMessages!.invalidations,
        );
        await canvas.scrollIntoViewIfNeeded();
        await expect(canvas).toBeInViewport();
        await expect
          .poll(() => worker.evaluate(() => globalThis.__rendererResumeMessages!.invalidations))
          .toBeGreaterThan(invalidationsBeforeReentry);
        await expect
          .poll(() => page.evaluate(() => globalThis.__rendererResume!.frames))
          .toBeGreaterThan(framesBefore);

        const zoomed = await zoomWithWheel(page, await currentViewport(page));
        const panned = await panWithKeyboard(page, zoomed);
        expect(panned.xMin).toBeGreaterThan(zoomed.xMin);
        await expectCanvasToContainChart(page);
        expect(await page.evaluate(() => globalThis.__rendererSafetyChart!.getRenderMode())).toBe(
          "worker",
        );
        expect(page.workers()).toHaveLength(1);
        expect(page.workers()[0]).toBe(worker);
        expect(workerClosed).toBe(false);
        expect(await page.evaluate(() => globalThis.__rendererResume!.errors)).toEqual([]);
        expect(pageErrors).toEqual([]);
      }
    } finally {
      await destroyChart(page);
    }
  });
}

test("Range handles use the Safari-compatible resize cursor", async ({ page, browserName }) => {
  await mountLineChart(page, "main");
  const canvas = page.locator("#chart");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Chart canvas has no layout box.");

  await page.mouse.move(box.x + 80, box.y + box.height - 27);
  await expect
    .poll(() => canvas.evaluate((element) => element.style.cursor))
    .toBe(browserName === "webkit" ? "col-resize" : "ew-resize");
  await destroyChart(page);
});

test("View-only charts expose labelled image semantics", async ({ page }) => {
  const initial = await mountLineChart(page, "main", false);
  expect(initial.renderMode).toBe("main");
  const canvas = page.getByRole("img", { name: "Line renderer test chart" });
  await expect(canvas).not.toHaveAttribute("tabindex");
  await expectCanvasToContainChart(page);
  await destroyChart(page);
});

for (const renderMode of ["main", "worker"] as const) {
  test(`${renderMode} appearance updates clone caller-owned ImageBitmaps`, async ({ page }) => {
    const initial = await mountLineChart(page, renderMode);
    expect(initial.renderMode).toBe(renderMode);

    const result = await page.evaluate(async () => {
      const source = document.createElement("canvas");
      source.width = 8;
      source.height = 8;
      const context = source.getContext("2d");
      if (!context) throw new Error("ImageBitmap fixture context is unavailable.");
      context.fillStyle = "#ff00aa";
      context.fillRect(0, 0, source.width, source.height);
      const bitmap = await createImageBitmap(source);
      const chart = globalThis.__rendererSafetyChart!;
      const appearance = {
        chartBackground: { type: "image" as const, image: bitmap },
        overlay: {
          items: [
            {
              kind: "image" as const,
              src: bitmap,
              x: 4,
              y: 4,
              width: 8,
              height: 8,
            },
          ],
        },
      };

      chart.updateAppearance(appearance);
      const afterFirst = { width: bitmap.width, height: bitmap.height };
      chart.batch(() => {
        chart.updateAppearance(appearance);
        chart.setViewport({ xMin: 1_000, xMax: 8_000 }, { animated: false });
      });
      const afterSecond = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return { afterFirst, afterSecond };
    });

    expect(result).toEqual({
      afterFirst: { width: 8, height: 8 },
      afterSecond: { width: 8, height: 8 },
    });
    await expectCanvasCornerColor(page, [255, 0, 170]);
    await destroyChart(page);
  });

  test(`${renderMode} reports a detached overlay bitmap without destroying the chart`, async ({
    page,
  }) => {
    const initial = await mountLineChart(page, renderMode);
    expect(initial.renderMode).toBe(renderMode);

    const result = await page.evaluate(async () => {
      const source = document.createElement("canvas");
      source.width = 8;
      source.height = 8;
      const bitmap = await createImageBitmap(source);
      bitmap.close();
      const chart = globalThis.__rendererSafetyChart!;
      let callbackError: Record<string, unknown> | undefined;
      chart.setOverlayErrorCallback((error) => {
        callbackError = {
          name: error.name,
          sources: error.sources,
          causeName: error.cause?.name,
        };
      });
      let rejectedError: Record<string, unknown> | undefined;
      try {
        await chart.setOverlay({
          items: [{ kind: "image", src: bitmap, x: 0, y: 0, width: 8, height: 8 }],
        });
      } catch (error) {
        const overlayError = error as Error & {
          sources?: readonly string[];
          cause?: Error;
        };
        rejectedError = {
          name: overlayError.name,
          sources: overlayError.sources,
          causeName: overlayError.cause?.name,
        };
      }

      await chart.setOverlay({
        items: [{ kind: "rect", x: 0, y: 0, width: 4, height: 4 }],
      });
      chart.setOverlayErrorCallback(null);
      return { callbackError, rejectedError, viewport: chart.getViewport() };
    });

    const expectedError = {
      name: "ChartOverlayError",
      sources: ["[detached ImageBitmap]"],
      causeName: "DataCloneError",
    };
    expect(result.callbackError).toEqual(expectedError);
    expect(result.rejectedError).toEqual(expectedError);
    expect(result.viewport).toEqual(initial.viewport);
    await destroyChart(page);
  });

  test(`${renderMode} resolves a mixed construction-time overlay`, async ({ page }) => {
    await page.goto(origin);
    const result = await page.evaluate(
      async ({ mode, overlayUrl }) => {
        const moduleUrl = "/packages/line/dist/index.js";
        const { LineChart } = await import(moduleUrl);
        const canvas = document.createElement("canvas");
        canvas.id = "chart";
        canvas.style.cssText = "display:block;width:120px;height:80px";
        document.body.style.margin = "0";
        document.body.append(canvas);

        const source = document.createElement("canvas");
        source.width = 8;
        source.height = 8;
        const context = source.getContext("2d");
        if (!context) throw new Error("Construction overlay fixture context is unavailable.");
        context.fillStyle = "#ff0000";
        context.fillRect(0, 0, 8, 8);
        const bitmap = await createImageBitmap(source);
        const common = {
          y: 4,
          xUnit: "px" as const,
          yUnit: "px" as const,
          relativeTo: "canvas" as const,
        };
        const chart = new LineChart(canvas, {
          renderMode: mode,
          animated: false,
          chartBackground: "#000000",
          series: [{ name: "Series" }],
          overlay: {
            items: [
              { kind: "image", src: bitmap, x: 4, width: 12, height: 12, ...common },
              { kind: "image", src: overlayUrl, x: 24, width: 12, height: 12, ...common },
              {
                kind: "rect",
                x: 44,
                width: 12,
                height: 12,
                fill: { color: "#0000ff" },
                ...common,
              },
            ],
          },
        });
        chart.setOverlayErrorCallback((error: Error) => {
          canvas.dataset.overlayError = error.name;
        });
        await chart.initialize();
        globalThis.__rendererSafetyChart = chart;
        globalThis.__rendererSafetyBitmap = bitmap;
        return {
          renderMode: chart.getRenderMode(),
          bitmap: { width: bitmap.width, height: bitmap.height },
        };
      },
      { mode: renderMode, overlayUrl: `${origin}/overlay-fixture.png` },
    );

    expect(result).toEqual({ renderMode, bitmap: { width: 8, height: 8 } });
    await expectCanvasPixelColor(page, 8, 8, [255, 0, 0]);
    await expectCanvasPixelColor(page, 28, 8, [0, 255, 0]);
    await expectCanvasPixelColor(page, 48, 8, [0, 0, 255]);
    await expect(page.locator("#chart")).not.toHaveAttribute("data-overlay-error");
    await page.evaluate(() => {
      globalThis.__rendererSafetyChart?.destroy();
      globalThis.__rendererSafetyBitmap?.close();
      delete globalThis.__rendererSafetyChart;
      delete globalThis.__rendererSafetyBitmap;
    });
  });
}

test("pre-initialize main updateAppearance snapshots its ImageBitmap", async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const moduleUrl = "/packages/line/dist/index.js";
    const { LineChart } = await import(moduleUrl);
    const source = document.createElement("canvas");
    source.width = 8;
    source.height = 8;
    const context = source.getContext("2d");
    if (!context) throw new Error("Pre-initialize bitmap fixture context is unavailable.");
    context.fillStyle = "#ff00aa";
    context.fillRect(0, 0, source.width, source.height);
    const bitmap = await createImageBitmap(source);
    const canvas = document.createElement("canvas");
    canvas.id = "chart";
    canvas.style.cssText = "display:block;width:120px;height:80px";
    document.body.style.margin = "0";
    document.body.append(canvas);
    const chart = new LineChart(canvas, {
      renderMode: "main",
      animated: false,
      chartBackground: "#000000",
      series: [{ name: "Series" }],
    });

    chart.updateAppearance({ chartBackground: { type: "image", image: bitmap } });
    bitmap.close();
    await chart.initialize();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    globalThis.__rendererSafetyChart = chart;
    return {
      renderMode: chart.getRenderMode(),
      bitmap: { width: bitmap.width, height: bitmap.height },
    };
  });

  expect(result).toEqual({ renderMode: "main", bitmap: { width: 0, height: 0 } });
  await expectCanvasPixelColor(page, 1, 1, [255, 0, 170]);
  await destroyChart(page);
});

test("setOverlay preserves the previous overlay when every image fails", async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(async (missingImageUrl) => {
    const moduleUrl = "/packages/line/dist/index.js";
    const { LineChart } = await import(moduleUrl);
    const canvas = document.createElement("canvas");
    canvas.id = "chart";
    canvas.style.cssText = "display:block;width:120px;height:80px";
    document.body.style.margin = "0";
    document.body.append(canvas);
    const chart = new LineChart(canvas, {
      renderMode: "main",
      animated: false,
      chartBackground: "#000000",
      series: [{ name: "Series" }],
    });
    await chart.initialize();
    const previousOverlay = {
      items: [
        {
          kind: "rect" as const,
          x: 4,
          y: 4,
          width: 12,
          height: 12,
          xUnit: "px" as const,
          yUnit: "px" as const,
          relativeTo: "canvas" as const,
          fill: { color: "#00ff00" },
        },
      ],
    };
    await chart.setOverlay(previousOverlay);
    let rejectedError: Record<string, unknown> | undefined;
    try {
      await chart.setOverlay({
        items: [
          {
            kind: "image",
            src: missingImageUrl,
            x: 4,
            y: 4,
            width: 12,
            height: 12,
            xUnit: "px",
            yUnit: "px",
            relativeTo: "canvas",
          },
        ],
      });
    } catch (error) {
      const overlayError = error as Error & { sources?: readonly string[] };
      rejectedError = { name: overlayError.name, sources: overlayError.sources };
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    globalThis.__rendererSafetyChart = chart;
    return {
      rejectedError,
      overlay: chart.getAppearance().overlay,
    };
  }, `${origin}/missing-overlay.png`);

  expect(result).toEqual({
    rejectedError: {
      name: "ChartOverlayError",
      sources: [`${origin}/missing-overlay.png`],
    },
    overlay: {
      items: [
        {
          kind: "rect",
          x: 4,
          y: 4,
          width: 12,
          height: 12,
          xUnit: "px",
          yUnit: "px",
          relativeTo: "canvas",
          fill: { color: "#00ff00" },
        },
      ],
    },
  });
  await expectCanvasPixelColor(page, 8, 8, [0, 255, 0]);
  await destroyChart(page);
});

test("primitive-only setOverlay does not load the overlay image decoder", async ({ page }) => {
  const overlayDecoderRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/packages/core/dist/chart/overlay.js") {
      overlayDecoderRequests.push(request.url());
    }
  });
  await mountLineChart(page, "main");

  await page.evaluate(async () => {
    await globalThis.__rendererSafetyChart!.setOverlay({
      items: [
        {
          kind: "rect",
          x: 4,
          y: 4,
          width: 12,
          height: 12,
          fill: { color: "#00ff00" },
        },
      ],
    });
  });

  expect(overlayDecoderRequests).toEqual([]);
  await destroyChart(page);
});

test("setOverlay reports a lazy overlay decoder import failure", async ({ page }) => {
  await page.route("**/packages/core/dist/chart/overlay.js", (route) => route.abort("failed"));
  await mountLineChart(page, "main");

  const result = await page.evaluate(async (overlayUrl) => {
    const chart = globalThis.__rendererSafetyChart!;
    let callbackError: Record<string, unknown> | undefined;
    chart.setOverlayErrorCallback((error) => {
      callbackError = {
        name: error.name,
        sources: error.sources,
        causeName: error.cause?.name,
      };
    });
    let rejectedError: Record<string, unknown> | undefined;
    try {
      await chart.setOverlay({
        items: [{ kind: "image", src: overlayUrl, x: 0, y: 0, width: 8, height: 8 }],
      });
    } catch (error) {
      const overlayError = error as Error & {
        sources?: readonly string[];
        cause?: Error;
      };
      rejectedError = {
        name: overlayError.name,
        sources: overlayError.sources,
        causeName: overlayError.cause?.name,
      };
    }
    chart.setOverlayErrorCallback(null);
    return { callbackError, rejectedError };
  }, `${origin}/overlay-fixture.png`);

  const expectedError = {
    name: "ChartOverlayError",
    sources: ["[overlay]"],
    causeName: "TypeError",
  };
  expect(result).toEqual({ callbackError: expectedError, rejectedError: expectedError });
  await destroyChart(page);
});

test("updateAppearance reports a lazy overlay decoder import failure without an unhandled rejection", async ({
  page,
}) => {
  await page.route("**/packages/core/dist/chart/overlay.js", (route) => route.abort("failed"));
  await mountLineChart(page, "main");

  const result = await page.evaluate(async (overlayUrl) => {
    const chart = globalThis.__rendererSafetyChart!;
    let unhandledRejections = 0;
    const onUnhandledRejection = () => {
      unhandledRejections++;
    };
    addEventListener("unhandledrejection", onUnhandledRejection);
    const callbackError = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Overlay decoder failure callback was not invoked.")),
        5_000,
      );
      chart.setOverlayErrorCallback((error) => {
        clearTimeout(timeout);
        resolve({
          name: error.name,
          sources: error.sources,
          causeName: error.cause?.name,
        });
      });
      chart.updateAppearance({
        overlay: {
          items: [{ kind: "image", src: overlayUrl, x: 0, y: 0, width: 8, height: 8 }],
        },
      });
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    removeEventListener("unhandledrejection", onUnhandledRejection);
    chart.setOverlayErrorCallback(null);
    return { callbackError, unhandledRejections };
  }, `${origin}/overlay-fixture.png`);

  expect(result).toEqual({
    callbackError: {
      name: "ChartOverlayError",
      sources: ["[overlay]"],
      causeName: "TypeError",
    },
    unhandledRejections: 0,
  });
  await destroyChart(page);
});

test("pre-initialize setOverlay reports a bitmap detached while delivery is pending", async ({
  page,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const moduleUrl = "/packages/line/dist/index.js";
    const { LineChart } = await import(moduleUrl);
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:320px;height:180px";
    document.body.append(canvas);
    const chart = new LineChart(canvas, {
      renderMode: "main",
      animated: false,
      series: [{ name: "Series" }],
    });
    const source = document.createElement("canvas");
    source.width = 8;
    source.height = 8;
    const bitmap = await createImageBitmap(source);
    let callbackError: Record<string, unknown> | undefined;
    chart.setOverlayErrorCallback(
      (error: { name: string; sources: readonly string[]; cause?: Error }) => {
        callbackError = {
          name: error.name,
          sources: error.sources,
          causeName: error.cause?.name,
        };
      },
    );

    const pending = chart.setOverlay({
      items: [{ kind: "image", src: bitmap, x: 0, y: 0, width: 8, height: 8 }],
    });
    bitmap.close();
    let rejectedError: Record<string, unknown> | undefined;
    try {
      await pending;
    } catch (error) {
      const overlayError = error as Error & {
        sources?: readonly string[];
        cause?: Error;
      };
      rejectedError = {
        name: overlayError.name,
        sources: overlayError.sources,
        causeName: overlayError.cause?.name,
      };
    }

    await chart.setOverlay({ items: [{ kind: "rect", x: 0, y: 0, width: 4, height: 4 }] });
    const renderMode = chart.getRenderMode();
    chart.destroy();
    return { callbackError, rejectedError, renderMode };
  });

  const expectedError = {
    name: "ChartOverlayError",
    sources: ["[detached ImageBitmap]"],
    causeName: "DataCloneError",
  };
  expect(result).toEqual({
    callbackError: expectedError,
    rejectedError: expectedError,
    renderMode: "main",
  });
});

test("@mobile @pinch Line responds to a trusted two-finger pinch", async ({ page }) => {
  const initial = await mountLineChart(page, "auto", true, {
    width: 360,
    height: 620,
  });
  await expectCanvasToContainChart(page);

  await pinchCanvas(page);

  await expect
    .poll(async () => {
      const viewport = await currentViewport(page);
      return viewport.xMax - viewport.xMin;
    })
    .toBeLessThan(initial.viewport.xMax - initial.viewport.xMin);
  await destroyChart(page);
});

test("@mobile @pinch Stock responds to a trusted two-finger pinch", async ({ page }) => {
  const initial = await mountStockChart(page, "auto", { width: 360, height: 620 });
  await expectCanvasToContainChart(page);

  await pinchCanvas(page);

  await expect
    .poll(async () => {
      const viewport = await currentViewport(page);
      return viewport.xMax - viewport.xMin;
    })
    .toBeLessThan(initial.viewport.xMax - initial.viewport.xMin);
  await destroyChart(page);
});

test("@mobile Line resets after a trusted double-tap", async ({ page }) => {
  const initial = await mountLineChart(page, "auto", true, { width: 360, height: 620 });
  await zoomAndDoubleTapToReset(page, initial);
  await destroyChart(page);
});

test("@mobile Stock resets after a trusted double-tap", async ({ page }) => {
  const initial = await mountStockChart(page, "auto", { width: 360, height: 620 });
  await zoomAndDoubleTapToReset(page, initial);
  await destroyChart(page);
});

async function zoomAndDoubleTapToReset(page: Page, initial: MountedChartResult): Promise<void> {
  const fullRange = initial.viewport.xMax - initial.viewport.xMin;
  await page.evaluate(
    ({ xMin, xMax }) => {
      globalThis.__rendererSafetyChart!.setViewport({ xMin, xMax }, { animated: false });
    },
    {
      xMin: initial.viewport.xMin + fullRange * 0.25,
      xMax: initial.viewport.xMax - fullRange * 0.25,
    },
  );
  await expect
    .poll(async () => (await currentViewport(page)).xMax - (await currentViewport(page)).xMin)
    .toBeLessThan(fullRange);

  const box = await page.locator("#chart").boundingBox();
  if (!box) throw new Error("Chart canvas has no layout box.");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
  await page.waitForTimeout(50);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);

  await expect
    .poll(async () => (await currentViewport(page)).xMax - (await currentViewport(page)).xMin)
    .toBe(fullRange);
}

async function mountLineChart(
  page: Page,
  renderMode: RequestedRenderMode,
  interactive = true,
  dimensions: { width: number; height: number } = { width: 960, height: 620 },
): Promise<MountedChartResult> {
  await page.goto(origin);
  return page.evaluate(
    async ({ mode, interactive, dimensions }) => {
      const moduleUrl = "/packages/line/dist/index.js";
      const { LineChart } = await import(moduleUrl);
      const canvas = document.createElement("canvas");
      canvas.id = "chart";
      canvas.setAttribute("aria-label", "Line renderer test chart");
      canvas.style.cssText = `display:block;width:${dimensions.width}px;height:${dimensions.height}px`;
      document.body.style.margin = "0";
      document.body.append(canvas);

      const chart = new LineChart(canvas, {
        renderMode: mode,
        interactive,
        animated: false,
        chartBackground: "#10182b",
        grid: { color: "#314466" },
        title: { text: "Renderer safety net" },
        legend: {
          visible: true,
          position: "top",
          layout: "row",
          interactive: true,
        },
        rangeSelector: { visible: true, height: 54 },
        series: [
          { name: "Telemetry", color: "#49d3ff", type: "line" },
          { name: "Controller", color: "#ffb02e", type: "step-after" },
          {
            name: "Envelope",
            color: "#9d7cff",
            type: "range",
            width: 0,
            band: {
              fill: 0.22,
              borderColor: "#9d7cff",
              borderStyle: "dashed",
              borderWidth: 1,
            },
          },
          {
            name: "Events",
            color: "#4ee6a8",
            type: "bar",
            bar: { widthRatio: 0.72 },
          },
        ],
      });
      await chart.initialize();

      const rendered = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Line renderer did not emit stats.")),
          10_000,
        );
        chart.setStatsCallback(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { intervalMs: 0 },
        );
      });
      const length = 24_000;
      const x = new Float64Array(length);
      const telemetry = new Float64Array(length);
      const controller = new Float64Array(length);
      const low = new Float64Array(length);
      const high = new Float64Array(length);
      const events = new Float64Array(length);
      for (let index = 0; index < length; index++) {
        const center = 90 + Math.sin(index / 1_100) * 14;
        x[index] = index;
        telemetry[index] = center + Math.sin(index / 37) * 2;
        controller[index] = 66 + Math.floor((index % 2_400) / 600) * 5;
        low[index] = center - 8 - Math.sin(index / 211);
        high[index] = center + 8 + Math.sin(index / 211);
        events[index] = index % 1_307 < 12 ? 28 : 0;
      }
      chart.setMultiSeriesData({
        x,
        series: [telemetry, controller, { low, high }, events],
        length,
        seriesCount: 4,
      });
      await rendered;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      globalThis.__rendererSafetyChart = chart;
      return {
        renderMode: chart.getRenderMode(),
        workerCapable:
          typeof OffscreenCanvas !== "undefined" &&
          typeof canvas.transferControlToOffscreen === "function",
        viewport: chart.getViewport(),
      };
    },
    { mode: renderMode, interactive, dimensions },
  );
}

async function mountStockChart(
  page: Page,
  renderMode: RequestedRenderMode,
  dimensions: { width: number; height: number } = { width: 960, height: 620 },
): Promise<MountedChartResult> {
  await page.goto(origin);
  return page.evaluate(
    async ({ mode, dimensions }) => {
      const moduleUrl = "/packages/stock/dist/index.js";
      const { StockChart } = await import(moduleUrl);
      const canvas = document.createElement("canvas");
      canvas.id = "chart";
      canvas.setAttribute("aria-label", "Stock renderer test chart");
      canvas.style.cssText = `display:block;width:${dimensions.width}px;height:${dimensions.height}px`;
      document.body.style.margin = "0";
      document.body.append(canvas);

      const length = 4_096;
      const minute = 60_000;
      const start = Date.UTC(2025, 0, 1);
      const timestamp = new Float64Array(length);
      const open = new Float64Array(length);
      const high = new Float64Array(length);
      const low = new Float64Array(length);
      const close = new Float64Array(length);
      const volume = new Float64Array(length);
      for (let index = 0; index < length; index++) {
        const base = 100 + Math.sin(index / 530) * 12 + index / 4_000;
        const movement = Math.sin(index / 17) * 1.8;
        timestamp[index] = start + index * minute;
        open[index] = base;
        close[index] = base + movement;
        high[index] = Math.max(open[index], close[index]) + 1.4;
        low[index] = Math.min(open[index], close[index]) - 1.4;
        volume[index] = 1_000 + (index % 97) * 23;
      }

      const chart = new StockChart(canvas, {
        renderMode: mode,
        animated: false,
        chartBackground: "#10182b",
        grid: { color: "#314466" },
        rangeSelector: { visible: true, height: 54 },
        showVolume: true,
        candleColors: { up: "#33d6a6", down: "#ff6577" },
        indicators: [
          { id: "sma", type: "sma", period: 20, color: "#5aa9ff" },
          {
            id: "bands",
            type: "bollinger",
            period: 20,
            deviation: 2,
            fillOpacity: 0.1,
          },
          { id: "vwap", type: "vwap", color: "#ffb02e" },
        ],
        volumeProfile: {
          rows: 36,
          placement: "left",
          width: 110,
          showPointOfControl: true,
        },
        priceLines: [
          {
            id: "target",
            price: 108,
            label: "Target",
            lineDash: [6, 3],
            showAxisLabel: true,
          },
        ],
        markers: [
          {
            id: "event",
            timestamp: timestamp[Math.floor(length * 0.72)],
            position: "above",
            label: "A",
          },
        ],
      });
      await chart.initialize();
      const rendered = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Stock renderer did not emit stats.")),
          10_000,
        );
        chart.setStatsCallback(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { intervalMs: 0 },
        );
      });
      chart.setData({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        length,
      });
      await rendered;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      globalThis.__rendererSafetyChart = chart;
      return {
        renderMode: chart.getRenderMode(),
        workerCapable:
          typeof OffscreenCanvas !== "undefined" &&
          typeof canvas.transferControlToOffscreen === "function",
        viewport: chart.getViewport(),
      };
    },
    { mode: renderMode, dimensions },
  );
}

async function pinchCanvas(page: Page): Promise<void> {
  const canvas = page.locator("#chart");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Chart canvas has no layout box.");
  await canvas.evaluate((element) => {
    element.dataset.pinchEventsTrusted = "true";
    for (const type of ["touchstart", "touchmove", "touchend"]) {
      element.addEventListener(
        type,
        (event) => {
          if (!event.isTrusted) element.dataset.pinchEventsTrusted = "false";
        },
        { once: true },
      );
    }
  });

  const session = await page.context().newCDPSession(page);
  const centerY = box.y + box.height * 0.42;
  const points = (left: number, right: number) => [
    { x: box.x + left, y: centerY, id: 1, radiusX: 8, radiusY: 8, force: 0.5 },
    { x: box.x + right, y: centerY, id: 2, radiusX: 8, radiusY: 8, force: 0.5 },
  ];
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(box.width * 0.32, box.width * 0.68),
    });
    for (const spread of [0.26, 0.22, 0.18]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(box.width * spread, box.width * (1 - spread)),
      });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
  await expect(canvas).toHaveAttribute("data-pinch-events-trusted", "true");
}

async function zoomWithWheel(page: Page, before: Viewport): Promise<Viewport> {
  const canvas = page.locator("#chart");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Chart canvas has no layout box.");
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await page.mouse.wheel(0, -500);
  await expect
    .poll(async () => {
      const viewport = await currentViewport(page);
      return viewport.xMax - viewport.xMin;
    })
    .toBeLessThan(before.xMax - before.xMin);
  return currentViewport(page);
}

async function panWithKeyboard(page: Page, before: Viewport): Promise<Viewport> {
  await page.locator("#chart").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await currentViewport(page)).xMin).toBeGreaterThan(before.xMin);
  return currentViewport(page);
}

async function currentViewport(page: Page): Promise<Viewport> {
  return page.evaluate(() => globalThis.__rendererSafetyChart!.getViewport());
}

async function destroyChart(page: Page): Promise<void> {
  await page.evaluate(() => {
    globalThis.__rendererSafetyChart!.destroy();
    delete globalThis.__rendererSafetyChart;
  });
}

async function expectCanvasToContainChart(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const metrics = await readCanvasMetrics(page);
        return metrics.bucketCount > 24 && metrics.luminanceRange > 80;
      },
      { message: "canvas should contain rendered chart pixels" },
    )
    .toBe(true);
}

async function expectCanvasCornerColor(
  page: Page,
  expected: readonly [number, number, number],
): Promise<void> {
  await expect
    .poll(async () => {
      const screenshot = await page.locator("#chart").screenshot();
      const image = await loadImage(screenshot);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(2, 2, 1, 1).data;
      return expected.every((channel, index) => Math.abs(pixel[index] - channel) <= 3);
    })
    .toBe(true);
}

async function expectCanvasPixelColor(
  page: Page,
  x: number,
  y: number,
  expected: readonly [number, number, number],
): Promise<void> {
  await expect
    .poll(async () => {
      const screenshot = await page.locator("#chart").screenshot();
      const image = await loadImage(screenshot);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(x, y, 1, 1).data;
      return expected.every((channel, index) => Math.abs(pixel[index] - channel) <= 3);
    })
    .toBe(true);
}

async function readCanvasMetrics(
  page: Page,
): Promise<{ bucketCount: number; luminanceRange: number }> {
  const screenshot = await page.locator("#chart").screenshot();
  const image = await loadImage(screenshot);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const buckets = new Set<number>();
  let minLuminance = 255;
  let maxLuminance = 0;
  for (let index = 0; index < pixels.length; index += 16) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    minLuminance = Math.min(minLuminance, luminance);
    maxLuminance = Math.max(maxLuminance, luminance);
    buckets.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
  }
  return {
    bucketCount: buckets.size,
    luminanceRange: maxLuminance - minLuminance,
  };
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (file.endsWith(".json") || file.endsWith(".map")) {
    return "application/json; charset=utf-8";
  }
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

interface MountedChartResult {
  renderMode: "main" | "worker";
  workerCapable: boolean;
  viewport: Viewport;
}

type RequestedRenderMode = "main" | "auto" | "worker";

function resolveExpectedRenderMode(
  requested: RequestedRenderMode,
  workerCapable: boolean,
): "main" | "worker" {
  if (requested === "main") return "main";
  return workerCapable ? "worker" : "main";
}

declare global {
  var __rendererSafetyChart:
    | {
        getRenderMode(): "main" | "worker";
        getViewport(): Viewport;
        setViewport(viewport: Partial<Viewport>, options?: { animated?: boolean }): void;
        updateAppearance(appearance: Record<string, unknown>): void;
        setOverlay(overlay: { items: Array<Record<string, unknown>> }): Promise<void>;
        setOverlayErrorCallback(
          callback:
            ((error: { name: string; sources: readonly string[]; cause?: Error }) => void) | null,
        ): void;
        setRendererErrorCallback(callback: (error: Error) => void): void;
        setStatsCallback(callback: () => void, options: { intervalMs: number }): void;
        batch(fn: () => void): void;
        destroy(): void;
      }
    | undefined;
  var __rendererSafetyBitmap: ImageBitmap | undefined;
  var __rendererResume: { frames: number; errors: string[] } | undefined;
  var __rendererResumeMessages: { invalidations: number; resizeWidth: number | null } | undefined;
}
