#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  PACKAGE_DIRECTORIES,
  assertPackageDirectory,
  findLocalDependencySpecifiers,
} from "./release-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedLicense = "PolyForm-Noncommercial-1.0.0";
const expectedPackageLicense = `PolyForm Noncommercial License 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0

Required Notice: Copyright 2026 Different Planet - Unipessoal Lda.`;
const packagesWithBundledHelpers = new Set([
  "@sixtyfold/core",
  "@sixtyfold/line",
  "@sixtyfold/stock",
]);
const aggregateGzipBudgets = Object.freeze({
  // These are aggregate package-artifact ratchets, not browser download
  // claims. Browser runtime sizes are measured separately in a clean consumer.
  // Core ships unminified with preserveModules, so this counts JSDoc a browser
  // never downloads; the browser runtime budgets below are the wire-size gate.
  "@sixtyfold/core": 60_000,
  "@sixtyfold/line": 80_000,
  "@sixtyfold/stock": 63_000,
  "@sixtyfold/ssr": 3_000,
  // The archive contains the combined catalog plus independently consumable
  // Line and Stock catalogs. Focused runtime budgets are asserted separately.
  "@sixtyfold/themes": 21_000,
  "@sixtyfold/react": 8_000,
  "@sixtyfold/vue": 8_000,
  "@sixtyfold/angular": 15_000,
  "@sixtyfold/svelte": 12_000,
  "@sixtyfold/solid": 8_000,
  "@sixtyfold/mcp": 24_000,
});
const initialWorkerBrowserRuntimeGzipBudgets = Object.freeze({
  line: 63_000,
  stock: 55_000,
});
const browserRuntimeGzipBudgets = Object.freeze({
  line: 65_000,
  stock: 57_000,
});
const initialMainThreadBrowserRuntimeGzipBudgets = Object.freeze({
  line: 62_000,
  stock: 54_000,
});
const mainThreadBrowserRuntimeGzipBudgets = Object.freeze({
  line: 64_000,
  stock: 56_000,
});
const prohibitedNetworkPatterns = Object.freeze([
  { pattern: /https?:\/\//u, description: "an embedded HTTP(S) destination" },
  { pattern: /\bnavigator\s*\.\s*sendBeacon\b/u, description: "sendBeacon telemetry" },
  { pattern: /\bXMLHttpRequest\b/u, description: "XMLHttpRequest transport" },
  { pattern: /\bnew\s+WebSocket\s*\(/u, description: "a WebSocket transport" },
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result;
}

function archiveName(manifest) {
  return `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
}

function optionalOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyExportTargets(manifest, entries) {
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (subpath === "./package.json") continue;
    if (typeof target === "string") {
      assert(
        entries.has(`package/${target.replace(/^\.\//, "")}`),
        `${manifest.name}: missing export ${target}`,
      );
      continue;
    }

    assert(target && typeof target === "object", `${manifest.name}: invalid export ${subpath}`);
    assert(
      typeof target.types === "string",
      `${manifest.name}: export ${subpath} has no types condition`,
    );
    const runtimeConditions = ["svelte", "import", "default"].filter(
      (condition) => typeof target[condition] === "string",
    );
    assert(
      runtimeConditions.length > 0,
      `${manifest.name}: export ${subpath} has no runtime condition`,
    );
    for (const condition of ["types", ...runtimeConditions]) {
      const file = target[condition];
      if (file.includes("*")) {
        const prefix = `package/${file.replace(/^\.\//, "").split("*")[0]}`;
        assert(
          [...entries].some((entry) => entry.startsWith(prefix)),
          `${manifest.name}: wildcard export ${file} has no files`,
        );
      } else {
        assert(
          entries.has(`package/${file.replace(/^\.\//, "")}`),
          `${manifest.name}: missing export target ${file}`,
        );
      }
    }
  }
}

async function inspectArchive(archivePath, sourceManifest, workspaceVersions) {
  const list = run("tar", ["-tzf", archivePath]).stdout.split(/\r?\n/u).filter(Boolean);
  const entries = new Set(list);

  for (const required of ["package/package.json", "package/README.md", "package/LICENSE"]) {
    assert(entries.has(required), `${sourceManifest.name}: ${required} is absent from the tarball`);
  }
  if (packagesWithBundledHelpers.has(sourceManifest.name)) {
    assert(
      entries.has("package/THIRD_PARTY_NOTICES.md"),
      `${sourceManifest.name}: bundled runtime helpers have no THIRD_PARTY_NOTICES.md`,
    );
  }
  assert(
    [...entries].some((entry) => /\.(?:js|mjs|svelte)$/u.test(entry)),
    `${sourceManifest.name}: no browser runtime`,
  );
  assert(
    [...entries].some((entry) => entry.endsWith(".d.ts")),
    `${sourceManifest.name}: no declarations`,
  );
  assert(
    ![...entries].some((entry) => entry.endsWith(".d.ts.map")),
    `${sourceManifest.name}: declaration map points outside the tarball`,
  );
  assert(
    ![...entries].some((entry) => entry.startsWith("package/src/")),
    `${sourceManifest.name}: source directory leaked into tarball`,
  );
  assert(
    ![...entries].some((entry) => /(?:^|\/)(?:\.env|\.npmrc|\.git)(?:$|\/)/u.test(entry)),
    `${sourceManifest.name}: private configuration leaked into tarball`,
  );

  const packedManifest = JSON.parse(
    run("tar", ["-xOf", archivePath, "package/package.json"]).stdout,
  );
  assert(
    packedManifest.name === sourceManifest.name,
    `${sourceManifest.name}: packed name changed`,
  );
  assert(
    packedManifest.version === sourceManifest.version,
    `${sourceManifest.name}: packed version changed`,
  );
  assert(
    packedManifest.license === expectedLicense,
    `${sourceManifest.name}: incorrect SPDX license`,
  );
  assert(
    packedManifest.author === "Different Planet - Unipessoal Lda.",
    `${sourceManifest.name}: incorrect author`,
  );
  assert(packedManifest.private !== true, `${sourceManifest.name}: package is private`);
  assert(
    packedManifest.publishConfig?.access === "public",
    `${sourceManifest.name}: public access is not explicit`,
  );
  assert(
    packedManifest.publishConfig?.registry === "https://registry.npmjs.org/",
    `${sourceManifest.name}: registry is not canonical`,
  );
  assert(
    packedManifest.repository?.url === "git+https://github.com/60fold/components-js.git",
    `${sourceManifest.name}: repository metadata is not canonical`,
  );
  assert(
    typeof packedManifest.homepage === "string" &&
      packedManifest.homepage.startsWith("https://sixtyfold.dev/"),
    `${sourceManifest.name}: homepage metadata is missing`,
  );
  assert(
    packedManifest.bugs?.url === "https://github.com/60fold/components-js/issues",
    `${sourceManifest.name}: bugs metadata is not canonical`,
  );
  assert(
    packedManifest.sideEffects === false,
    `${sourceManifest.name}: sideEffects must remain false`,
  );
  const localDependencies = findLocalDependencySpecifiers(packedManifest);
  assert(
    localDependencies.length === 0,
    `${sourceManifest.name}: local dependency specifiers leaked into tarball: ${localDependencies
      .map(({ field, name, specifier }) => `${field}.${name}=${specifier}`)
      .join(", ")}`,
  );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(packedManifest[field] ?? {})) {
      if (!dependency.startsWith("@sixtyfold/")) continue;
      const dependencyVersion = workspaceVersions.get(dependency);
      assert(
        dependencyVersion,
        `${sourceManifest.name}: unknown workspace dependency ${dependency}`,
      );
      assert(
        range === `^${dependencyVersion}`,
        `${sourceManifest.name}: ${dependency} resolved to ${range}, expected ^${dependencyVersion}`,
      );
    }
  }
  if (sourceManifest.name === "@sixtyfold/mcp") {
    const catalogEntry = "package/knowledge/api-reference.json";
    assert(entries.has(catalogEntry), `${sourceManifest.name}: API catalog is absent`);
    const catalog = JSON.parse(run("tar", ["-xOf", archivePath, catalogEntry]).stdout);
    const expectedCatalogVersions = new Map(
      [...workspaceVersions].filter(([name]) => name !== "@sixtyfold/mcp"),
    );
    const actualCatalogVersions = new Map(
      (catalog.packages ?? []).map((entry) => [entry.name, entry.version]),
    );
    assert(
      actualCatalogVersions.size === expectedCatalogVersions.size,
      `${sourceManifest.name}: API catalog package count is not release-aligned`,
    );
    for (const [name, version] of expectedCatalogVersions) {
      assert(
        actualCatalogVersions.get(name) === version,
        `${sourceManifest.name}: API catalog identifies ${name}@${actualCatalogVersions.get(name) ?? "missing"}; expected ${version}`,
      );
    }
  }

  const license = run("tar", ["-xOf", archivePath, "package/LICENSE"]).stdout;
  assert(
    license.trim() === expectedPackageLicense,
    `${sourceManifest.name}: package license does not match the canonical notice`,
  );
  verifyExportTargets(packedManifest, entries);

  if (packagesWithBundledHelpers.has(sourceManifest.name)) {
    const notices = run("tar", ["-xOf", archivePath, "package/THIRD_PARTY_NOTICES.md"]).stdout;
    assert(
      notices.includes("@oxc-project/runtime"),
      `${sourceManifest.name}: OXC runtime notice is missing`,
    );
    assert(
      notices.includes("Rolldown runtime helpers"),
      `${sourceManifest.name}: Rolldown runtime notice is missing`,
    );
    assert(
      notices.includes("Copyright (c) 2023 Boshen"),
      `${sourceManifest.name}: OXC copyright is missing`,
    );
    assert(
      notices.includes("Copyright (c) 2024-present VoidZero Inc. & Contributors"),
      `${sourceManifest.name}: VoidZero copyright is missing`,
    );
  }

  const javascriptEntries = [...entries].filter((entry) => /\.(?:js|mjs|svelte)$/u.test(entry));
  const declarationEntries = [...entries].filter((entry) => entry.endsWith(".d.ts"));
  const declaredDependencies = new Set([
    ...Object.keys(packedManifest.dependencies ?? {}),
    ...Object.keys(packedManifest.optionalDependencies ?? {}),
    ...Object.keys(packedManifest.peerDependencies ?? {}),
  ]);
  let helperCodeSeen = false;
  let aggregateGzipBytes = 0;
  for (const entry of [...javascriptEntries, ...declarationEntries]) {
    const source = run("tar", ["-xOf", archivePath, entry]).stdout;
    if (/\.(?:js|mjs|svelte)$/u.test(entry)) {
      aggregateGzipBytes += gzipSync(Buffer.from(source), { level: 9 }).byteLength;
      helperCodeSeen ||=
        source.includes("@oxc-project+runtime") || source.includes("rolldown/runtime.js");
      for (const { pattern, description } of prohibitedNetworkPatterns) {
        assert(!pattern.test(source), `${sourceManifest.name}: ${entry} contains ${description}`);
      }
    }

    const scopedImport = /(?:from\s*|import\s*\()\s*["'](@sixtyfold\/[^/"']+)/gu;
    for (const match of source.matchAll(scopedImport)) {
      const dependency = match[1];
      if (dependency === sourceManifest.name) continue;
      assert(
        declaredDependencies.has(dependency),
        `${sourceManifest.name}: ${entry} imports undeclared dependency ${dependency}`,
      );
    }
  }
  if (helperCodeSeen) {
    assert(
      entries.has("package/THIRD_PARTY_NOTICES.md"),
      `${sourceManifest.name}: generated third-party helper code has no packed notice`,
    );
  }

  const budget = aggregateGzipBudgets[sourceManifest.name];
  assert(Number.isInteger(budget), `${sourceManifest.name}: no aggregate gzip budget is defined`);
  assert(
    aggregateGzipBytes <= budget,
    `${sourceManifest.name}: compiled JavaScript is ${aggregateGzipBytes.toLocaleString()} gzip bytes, above the ${budget.toLocaleString()}-byte budget`,
  );
  console.log(
    `${sourceManifest.name}: ${aggregateGzipBytes.toLocaleString()} / ${budget.toLocaleString()} aggregate gzip bytes; no embedded network destination`,
  );

  if (sourceManifest.name === "@sixtyfold/themes") {
    const lineEntry = run("tar", ["-xOf", archivePath, "package/dist/line.js"]).stdout;
    const lineCatalog = run("tar", [
      "-xOf",
      archivePath,
      "package/dist/lineCatalog.generated.js",
    ]).stdout;
    const stockEntry = run("tar", ["-xOf", archivePath, "package/dist/stock.js"]).stdout;
    const stockCatalog = run("tar", [
      "-xOf",
      archivePath,
      "package/dist/stockCatalog.generated.js",
    ]).stdout;
    assert(
      !lineEntry.includes("./index.js") && !lineCatalog.includes('"stock":'),
      "@sixtyfold/themes/line retains combined or Stock theme runtime data",
    );
    assert(
      !stockEntry.includes("./index.js") && !stockCatalog.includes('"line":'),
      "@sixtyfold/themes/stock retains combined or Line theme runtime data",
    );
    const lineGzip =
      gzipSync(Buffer.from(lineEntry), { level: 9 }).byteLength +
      gzipSync(Buffer.from(lineCatalog), { level: 9 }).byteLength;
    const stockGzip =
      gzipSync(Buffer.from(stockEntry), { level: 9 }).byteLength +
      gzipSync(Buffer.from(stockCatalog), { level: 9 }).byteLength;
    assert(
      lineGzip <= 6_800,
      `@sixtyfold/themes/line is ${lineGzip.toLocaleString()} gzip bytes, above its 6,800-byte focused budget`,
    );
    assert(
      stockGzip <= 5_400,
      `@sixtyfold/themes/stock is ${stockGzip.toLocaleString()} gzip bytes, above its 5,400-byte focused budget`,
    );
    console.log(
      `@sixtyfold/themes focused catalogs: Line ${lineGzip.toLocaleString()} / 6,800; Stock ${stockGzip.toLocaleString()} / 5,400 gzip bytes`,
    );
  }
}

async function writeConsumer(consumerDir, dependencies, lib, source) {
  await mkdir(consumerDir, { recursive: true });
  await writeFile(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  await writeFile(
    path.join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib,
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(consumerDir, "index.ts"), source);
}

async function writeBrowserPage(browserConsumer) {
  await writeFile(
    path.join(browserConsumer, "index.html"),
    `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Sixtyfold packed runtime</title></head>
  <body><script type="module" src="/index.ts"></script></body>
</html>
`,
  );
}

async function writeRuntimeBudgetConsumer(consumerDir, component, dependencies) {
  const className = component === "line" ? "LineChart" : "StockChart";
  await writeConsumer(
    consumerDir,
    dependencies,
    ["ES2022", "DOM", "DOM.Iterable"],
    `import { ${className} } from "@sixtyfold/${component}";

const canvas = document.createElement("canvas");
document.body.append(canvas);
const chart = new ${className}(canvas, {
  renderMode: "worker",
  animated: false,
  interactive: false,
  rangeSelector: { visible: false },
});
canvas.dataset.renderMode = chart.getRenderMode();
`,
  );
  await writeBrowserPage(consumerDir);
  await writeFile(
    path.join(consumerDir, "vite.config.mjs"),
    `export default {
  build: {
    manifest: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
};
`,
  );
}

async function filesBelow(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(directory);
  return files.sort();
}

async function assertPathAbsent(file, message) {
  try {
    await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function serveStatic(directory) {
  const root = path.resolve(directory);
  const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
  };
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const absolute = path.resolve(root, relative);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const info = await stat(absolute);
      const file = info.isDirectory() ? path.join(absolute, "index.html") : absolute;
      const body = await readFile(file);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": mimeTypes[path.extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "Packed browser server has no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function runPackedBrowser(browserConsumer) {
  const server = await serveStatic(path.join(browserConsumer, "dist"));
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const prohibitedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== server.origin) prohibitedRequests.push(request.url());
    if (["fetch", "xhr", "eventsource", "websocket"].includes(request.resourceType())) {
      prohibitedRequests.push(`${request.resourceType()}: ${request.url()}`);
    }
  });

  try {
    await page.goto(server.origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__sixtyfoldReleaseSmoke?.done === true, null, {
      timeout: 30_000,
    });
    const result = await page.evaluate(() => globalThis.__sixtyfoldReleaseSmoke);
    assert(
      result?.error === null,
      `Packed browser smoke failed: ${result?.error ?? "unknown error"}`,
    );
    assert(
      result.fetchCalls === 0,
      `Packed charts made ${result.fetchCalls} unexpected fetch calls`,
    );
    assert(result.modes?.lineMain === "main", "Packed line main-thread renderer did not run");
    assert(result.modes?.stockMain === "main", "Packed stock main-thread renderer did not run");
    assert(result.modes?.lineWorker === "worker", "Packed line worker renderer did not run");
    assert(result.modes?.stockWorker === "worker", "Packed stock worker renderer did not run");
    assert(
      result.metrics?.lineMainTotal === 12,
      "Packed line main-thread point total is incorrect",
    );
    assert(result.metrics?.lineWorkerTotal === 12, "Packed line worker point total is incorrect");
    assert(
      result.metrics?.stockMainTotal === 6,
      "Packed stock main-thread candle total is incorrect",
    );
    assert(result.metrics?.stockWorkerTotal === 6, "Packed stock worker candle total is incorrect");
    assert(result.metrics?.lineMainRendered > 0, "Packed line main-thread renderer drew no points");
    assert(
      result.metrics?.stockMainRendered > 0,
      "Packed stock main-thread renderer drew no candles",
    );
    assert(errors.length === 0, errors.join("\n"));
    assert(
      prohibitedRequests.length === 0,
      `Packed browser made prohibited requests:\n${prohibitedRequests.join("\n")}`,
    );
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}

async function verifyTreeShaking(treeConsumer) {
  const javascript = (await filesBelow(path.join(treeConsumer, "dist"))).filter((file) =>
    file.endsWith(".js"),
  );
  let gzipBytes = 0;
  let source = "";
  for (const file of javascript) {
    const contents = await readFile(file);
    gzipBytes += gzipSync(contents, { level: 9 }).byteLength;
    source += contents.toString("utf8");
  }
  assert(gzipBytes <= 8_000, `Tree-shaken stock utility consumer is ${gzipBytes} gzip bytes`);
  for (const forbidden of ["new Worker", "OffscreenCanvas", ".worker-", "fetch("]) {
    const index = source.indexOf(forbidden);
    const context =
      index === -1
        ? ""
        : source.slice(
            Math.max(0, index - 80),
            Math.min(source.length, index + forbidden.length + 80),
          );
    assert(index === -1, `Tree-shaken stock utility consumer retained ${forbidden}: ${context}`);
  }
  console.log(`Tree-shaken stock utility consumer: ${gzipBytes.toLocaleString()} gzip bytes`);
}

async function verifyBrowserRuntimeBudget(consumerDir, component) {
  const dist = path.join(consumerDir, "dist");
  const manifest = JSON.parse(await readFile(path.join(dist, ".vite", "manifest.json"), "utf8"));
  const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry === true);
  assert(entryKey, `Packed ${component} runtime budget build has no manifest entry`);

  const staticRuntimeFiles = new Set();
  const staticManifestEntries = new Set();
  const dynamicEntryKeys = new Set();
  // Follow only eager imports. Vite records the lazy main-thread renderer,
  // renderer engine, and URL-overlay decoder in `dynamicImports`.
  const visitStaticImports = (key) => {
    if (staticManifestEntries.has(key)) return;
    staticManifestEntries.add(key);
    const entry = manifest[key];
    assert(entry, `Packed ${component} runtime manifest is missing ${key}`);
    if (typeof entry.file === "string" && entry.file.endsWith(".js")) {
      staticRuntimeFiles.add(entry.file);
    }
    for (const importedKey of entry.imports ?? []) visitStaticImports(importedKey);
    for (const dynamicKey of entry.dynamicImports ?? []) dynamicEntryKeys.add(dynamicKey);
  };
  visitStaticImports(entryKey);

  const workerRuntimeFiles = new Set(staticRuntimeFiles);
  const workerPattern =
    component === "line" ? /chart\.worker-[^/]+\.js$/u : /stock\.worker-[^/]+\.js$/u;
  for (const file of await filesBelow(dist)) {
    const relative = path.relative(dist, file).split(path.sep).join("/");
    if (workerPattern.test(relative)) workerRuntimeFiles.add(relative);
  }
  assert(
    [...workerRuntimeFiles].some((file) => workerPattern.test(file)),
    `Packed ${component} runtime budget build emitted no worker asset`,
  );

  const describeManifestEntry = (key) =>
    [key, manifest[key]?.src, manifest[key]?.name, manifest[key]?.file]
      .filter((value) => typeof value === "string")
      .join("\n");
  const findDynamicEntry = (pattern, description) => {
    const matches = [...dynamicEntryKeys].filter((key) => pattern.test(describeManifestEntry(key)));
    assert(
      matches.length === 1,
      `Packed ${component} runtime expected one lazy ${description}, found ${matches.length}`,
    );
    return matches[0];
  };
  const overlayResolverKey = findDynamicEntry(/\/overlay(?:-|\.)/u, "URL-overlay decoder");
  const mainThreadRendererKey = findDynamicEntry(/MainThreadRenderer/u, "main-thread transport");
  const engineKey = findDynamicEntry(
    component === "line" ? /lineRenderer/u : /stockRenderer/u,
    "main-thread renderer engine",
  );
  assert(
    dynamicEntryKeys.size === 3,
    `Packed ${component} runtime has unexpected lazy entries: ${[...dynamicEntryKeys]
      .map(describeManifestEntry)
      .join("\n")}`,
  );

  const completeDynamicEntryKeys = new Set();
  const collectCompleteRuntimeFiles = (entryKeys) => {
    const files = new Set();
    const staticEntries = new Set();
    const lazyEntries = new Set();
    const visitStatic = (key) => {
      if (staticEntries.has(key)) return;
      staticEntries.add(key);
      const entry = manifest[key];
      assert(entry, `Packed ${component} lazy runtime manifest is missing ${key}`);
      if (typeof entry.file === "string" && entry.file.endsWith(".js")) {
        files.add(entry.file);
      }
      for (const importedKey of entry.imports ?? []) visitStatic(importedKey);
    };
    const visitLazy = (key) => {
      if (lazyEntries.has(key)) return;
      lazyEntries.add(key);
      completeDynamicEntryKeys.add(key);
      visitStatic(key);
      const entry = manifest[key];
      for (const dynamicKey of entry.dynamicImports ?? []) {
        visitLazy(dynamicKey);
      }
    };
    for (const key of entryKeys) visitLazy(key);
    return files;
  };

  const overlayResolverFiles = collectCompleteRuntimeFiles([overlayResolverKey]);
  const mainThreadFiles = collectCompleteRuntimeFiles([mainThreadRendererKey, engineKey]);
  const emittedDynamicEntryKeys = new Set(
    Object.keys(manifest).filter((key) => manifest[key]?.isDynamicEntry === true),
  );
  const unaccountedDynamicEntryKeys = [...emittedDynamicEntryKeys].filter(
    (key) => !completeDynamicEntryKeys.has(key),
  );
  const missingDynamicEntryKeys = [...completeDynamicEntryKeys].filter(
    (key) => !emittedDynamicEntryKeys.has(key),
  );
  assert(
    unaccountedDynamicEntryKeys.length === 0 && missingDynamicEntryKeys.length === 0,
    `Packed ${component} runtime lazy-entry accounting mismatch:\nunaccounted:\n${unaccountedDynamicEntryKeys
      .map(describeManifestEntry)
      .join("\n")}\nmissing:\n${missingDynamicEntryKeys.map(describeManifestEntry).join("\n")}`,
  );
  const completeWorkerRuntimeFiles = new Set([...workerRuntimeFiles, ...overlayResolverFiles]);
  const initialMainRuntimeFiles = new Set([...staticRuntimeFiles, ...mainThreadFiles]);
  const completeMainRuntimeFiles = new Set([...initialMainRuntimeFiles, ...overlayResolverFiles]);
  assert(
    initialMainRuntimeFiles.size > staticRuntimeFiles.size,
    `Packed ${component} runtime budget build emitted no lazy main-thread renderer`,
  );

  const initialWorkerGzipBytes = await sumGzipBytes(dist, workerRuntimeFiles);
  const initialWorkerBudget = initialWorkerBrowserRuntimeGzipBudgets[component];
  assert(
    initialWorkerGzipBytes <= initialWorkerBudget,
    `@sixtyfold/${component} initial worker-mode browser runtime is ${initialWorkerGzipBytes.toLocaleString()} gzip bytes, above its ${initialWorkerBudget.toLocaleString()}-byte budget`,
  );
  console.log(
    `@sixtyfold/${component} initial worker-mode browser runtime: ${initialWorkerGzipBytes.toLocaleString()} / ${initialWorkerBudget.toLocaleString()} gzip bytes`,
  );

  const workerGzipBytes = await sumGzipBytes(dist, completeWorkerRuntimeFiles);
  const workerBudget = browserRuntimeGzipBudgets[component];
  assert(
    workerGzipBytes <= workerBudget,
    `@sixtyfold/${component} complete worker-mode browser runtime is ${workerGzipBytes.toLocaleString()} gzip bytes, above its ${workerBudget.toLocaleString()}-byte budget`,
  );
  console.log(
    `@sixtyfold/${component} complete worker-mode browser runtime: ${workerGzipBytes.toLocaleString()} / ${workerBudget.toLocaleString()} gzip bytes`,
  );

  const initialMainGzipBytes = await sumGzipBytes(dist, initialMainRuntimeFiles);
  const initialMainBudget = initialMainThreadBrowserRuntimeGzipBudgets[component];
  assert(
    initialMainGzipBytes <= initialMainBudget,
    `@sixtyfold/${component} initial main-thread browser runtime is ${initialMainGzipBytes.toLocaleString()} gzip bytes, above its ${initialMainBudget.toLocaleString()}-byte budget`,
  );
  console.log(
    `@sixtyfold/${component} initial main-thread browser runtime: ${initialMainGzipBytes.toLocaleString()} / ${initialMainBudget.toLocaleString()} gzip bytes`,
  );

  const mainGzipBytes = await sumGzipBytes(dist, completeMainRuntimeFiles);
  const mainBudget = mainThreadBrowserRuntimeGzipBudgets[component];
  assert(
    mainGzipBytes <= mainBudget,
    `@sixtyfold/${component} complete main-thread browser runtime is ${mainGzipBytes.toLocaleString()} gzip bytes, above its ${mainBudget.toLocaleString()}-byte budget`,
  );
  console.log(
    `@sixtyfold/${component} complete main-thread browser runtime: ${mainGzipBytes.toLocaleString()} / ${mainBudget.toLocaleString()} gzip bytes`,
  );
}

async function sumGzipBytes(root, files) {
  let gzipBytes = 0;
  for (const file of files) {
    gzipBytes += gzipSync(await readFile(path.join(root, file)), { level: 9 }).byteLength;
  }
  return gzipBytes;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "sixtyfold-packed-release-"));
  const suppliedTarballsDir = optionalOption("--tarballs-dir");
  const selectedDirectoryValue = optionalOption("--package");
  const selectedDirectory = selectedDirectoryValue
    ? assertPackageDirectory(selectedDirectoryValue)
    : null;
  const tarballsDir = suppliedTarballsDir
    ? path.resolve(suppliedTarballsDir)
    : path.join(tempRoot, "tarballs");

  try {
    if (!suppliedTarballsDir) await mkdir(tarballsDir, { recursive: true });
    const archives = new Map();
    const sourceManifests = new Map();
    for (const directory of PACKAGE_DIRECTORIES) {
      const packageDir = path.join(repoRoot, "packages", directory);
      const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
      sourceManifests.set(directory, manifest);
    }
    const workspaceVersions = new Map(
      [...sourceManifests.values()].map((manifest) => [manifest.name, manifest.version]),
    );

    const directoriesToInspect = selectedDirectory ? [selectedDirectory] : PACKAGE_DIRECTORIES;
    for (const directory of directoriesToInspect) {
      const packageDir = path.join(repoRoot, "packages", directory);
      const manifest = sourceManifests.get(directory);
      const packDir = directory === "angular" ? path.join(packageDir, "dist") : packageDir;
      if (!suppliedTarballsDir) {
        run("pnpm", ["--dir", packDir, "pack", "--pack-destination", tarballsDir]);
      }
      const archivePath = path.join(tarballsDir, archiveName(manifest));
      await inspectArchive(archivePath, manifest, workspaceVersions);
      archives.set(manifest.name, archivePath);
    }

    if (selectedDirectory) {
      console.log(
        `@sixtyfold/${selectedDirectory} release tarball passes metadata, notice, dependency, bundle-budget, and no-network checks.`,
      );
      return;
    }

    const packedDependencies = Object.fromEntries(
      [...archives].map(([name, archivePath]) => [name, `file:${archivePath}`]),
    );
    const selectPackedDependencies = (...names) =>
      Object.fromEntries(names.map((name) => [name, packedDependencies[name]]));
    const browserConsumer = path.join(tempRoot, "browser-consumer");
    await writeConsumer(
      browserConsumer,
      selectPackedDependencies(
        "@sixtyfold/core",
        "@sixtyfold/line",
        "@sixtyfold/stock",
        "@sixtyfold/themes",
      ),
      ["ES2022", "DOM", "DOM.Iterable"],
      `import { DEFAULT_CHART_FONT_FAMILY, type MultiSeriesData } from "@sixtyfold/core";
import { LineChart, type LineChartOptions } from "@sixtyfold/line";
import { StockChart, type OHLCVData, type StockChartOptions } from "@sixtyfold/stock";
import {
  PUBLIC_THEME_IDS,
  PUBLIC_THEMES,
  getThemePreset,
  type ChartThemeId,
  type ChartThemePreset,
} from "@sixtyfold/themes";

interface ReleaseSmokeResult {
  done: boolean;
  error: string | null;
  fetchCalls: number;
  modes: Record<string, string>;
  metrics: Record<string, number>;
}

interface RenderStats {
  renderMode: "worker" | "main";
  totalPoints?: number;
  renderedPoints?: number;
  totalCandles?: number;
  renderedCandles?: number;
}

declare global {
  var __sixtyfoldReleaseSmoke: ReleaseSmokeResult;
}

type StatsChart = {
  setStatsCallback(
    callback: ((stats: RenderStats) => void) | null,
    options?: { intervalMs?: number },
  ): void;
};

const result: ReleaseSmokeResult = {
  done: false,
  error: null,
  fetchCalls: 0,
  modes: {},
  metrics: {},
};
globalThis.__sixtyfoldReleaseSmoke = result;
globalThis.fetch = (async () => {
  result.fetchCalls += 1;
  throw new Error("Unexpected package fetch during packed runtime smoke");
}) as typeof fetch;

const mainThreadTextDirections: CanvasDirection[] = [];
const nativeFillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function (
  text: string,
  x: number,
  y: number,
  maxWidth?: number,
): void {
  mainThreadTextDirections.push(this.direction);
  if (maxWidth === undefined) {
    nativeFillText.call(this, text, x, y);
  } else {
    nativeFillText.call(this, text, x, y, maxWidth);
  }
};

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 240;
  canvas.style.width = "480px";
  canvas.style.height = "240px";
  document.body.append(canvas);
  return canvas;
}

function nextStats(chart: StatsChart): Promise<RenderStats> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out waiting for chart stats")), 10_000);
    chart.setStatsCallback((stats) => {
      window.clearTimeout(timeout);
      chart.setStatsCallback(null);
      resolve(stats);
    }, { intervalMs: 16 });
  });
}

function lineData(): MultiSeriesData {
  return {
    x: new Float64Array([0, 1, 2, 3, 4, 5]),
    series: [
      new Float64Array([2, 5, 3, 8, 6, 9]),
      new Float64Array([8, 7, 9, 5, 6, 4]),
    ],
    length: 6,
    seriesCount: 2,
  };
}

function stockData(): OHLCVData {
  return {
    timestamp: new Float64Array([0, 60_000, 120_000, 180_000, 240_000, 300_000]),
    open: new Float64Array([10, 11, 12, 11, 13, 14]),
    high: new Float64Array([12, 13, 13, 14, 15, 16]),
    low: new Float64Array([9, 10, 10, 10, 12, 13]),
    close: new Float64Array([11, 12, 11, 13, 14, 15]),
    volume: new Float64Array([100, 120, 90, 140, 160, 180]),
    length: 6,
  };
}

async function runLine(mode: "worker" | "main"): Promise<RenderStats> {
  const directionStart = mainThreadTextDirections.length;
  const canvas = createCanvas();
  const options: LineChartOptions = {
    renderMode: mode,
    animated: false,
    interactive: false,
    textDirection: "rtl",
    labels: { top: { text: "مخطط الخطوط", align: "start" } },
    rangeSelector: { visible: false },
    series: [{ name: "الأول" }, { name: "الثاني" }],
  };
  const chart = new LineChart(canvas, options);
  await chart.initialize();
  const id: ChartThemeId = PUBLIC_THEME_IDS[1];
  const theme: ChartThemePreset = getThemePreset(id);
  chart.updateAppearance(theme.line.appearance);
  theme.line.series.forEach((appearance, index) => chart.updateSeriesAppearance(index, appearance));
  if (chart.getOptions().textDirection !== "rtl" || chart.getAppearance().textDirection !== "rtl") {
    throw new Error("Packed Line chart did not preserve explicit RTL direction");
  }
  const stats = nextStats(chart);
  chart.setMultiSeriesData(lineData());
  const resolved = await stats;
  if (
    mode === "main" &&
    !mainThreadTextDirections.slice(directionStart).includes("rtl")
  ) {
    throw new Error("Packed Line chart did not render text with explicit RTL direction");
  }
  chart.destroy();
  canvas.remove();
  return resolved;
}

async function runStock(mode: "worker" | "main"): Promise<RenderStats> {
  const directionStart = mainThreadTextDirections.length;
  const canvas = createCanvas();
  const options: StockChartOptions = {
    renderMode: mode,
    animated: false,
    interactive: false,
    textDirection: "rtl",
    labels: { top: { text: "مخطط الأسهم", align: "start" } },
    rangeSelector: { visible: false },
  };
  const chart = new StockChart(canvas, options);
  await chart.initialize();
  chart.updateAppearance(PUBLIC_THEMES.mainframe.stock.appearance);
  if (chart.getOptions().textDirection !== "rtl" || chart.getAppearance().textDirection !== "rtl") {
    throw new Error("Packed Stock chart did not preserve explicit RTL direction");
  }
  const stats = nextStats(chart);
  chart.setData(stockData());
  const resolved = await stats;
  if (
    mode === "main" &&
    !mainThreadTextDirections.slice(directionStart).includes("rtl")
  ) {
    throw new Error("Packed Stock chart did not render text with explicit RTL direction");
  }
  chart.destroy();
  canvas.remove();
  return resolved;
}

void (async () => {
  try {
    if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
      throw new Error("Chromium does not expose transferControlToOffscreen");
    }
    const lineMain = await runLine("main");
    const stockMain = await runStock("main");
    const lineWorker = await runLine("worker");
    const stockWorker = await runStock("worker");
    result.modes.lineMain = lineMain.renderMode;
    result.modes.stockMain = stockMain.renderMode;
    result.modes.lineWorker = lineWorker.renderMode;
    result.modes.stockWorker = stockWorker.renderMode;
    result.metrics.lineMainTotal = lineMain.totalPoints ?? -1;
    result.metrics.lineWorkerTotal = lineWorker.totalPoints ?? -1;
    result.metrics.lineMainRendered = lineMain.renderedPoints ?? -1;
    result.metrics.lineWorkerRendered = lineWorker.renderedPoints ?? -1;
    result.metrics.stockMainTotal = stockMain.totalCandles ?? -1;
    result.metrics.stockWorkerTotal = stockWorker.totalCandles ?? -1;
    result.metrics.stockMainRendered = stockMain.renderedCandles ?? -1;
    result.metrics.stockWorkerRendered = stockWorker.renderedCandles ?? -1;
    if (
      result.metrics.lineMainTotal !== result.metrics.lineWorkerTotal ||
      result.metrics.lineMainRendered !== result.metrics.lineWorkerRendered ||
      result.metrics.stockMainTotal !== result.metrics.stockWorkerTotal ||
      result.metrics.stockMainRendered !== result.metrics.stockWorkerRendered
    ) {
      throw new Error("Worker and main-thread packed render statistics diverged");
    }
    void DEFAULT_CHART_FONT_FAMILY;
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    result.done = true;
  }
})();
`,
    );
    await writeBrowserPage(browserConsumer);

    const lineRuntimeConsumer = path.join(tempRoot, "line-runtime-consumer");
    await writeRuntimeBudgetConsumer(
      lineRuntimeConsumer,
      "line",
      selectPackedDependencies("@sixtyfold/core", "@sixtyfold/line"),
    );
    const stockRuntimeConsumer = path.join(tempRoot, "stock-runtime-consumer");
    await writeRuntimeBudgetConsumer(
      stockRuntimeConsumer,
      "stock",
      selectPackedDependencies("@sixtyfold/core", "@sixtyfold/stock"),
    );

    const lineThemeConsumer = path.join(tempRoot, "line-theme-consumer");
    await writeConsumer(
      lineThemeConsumer,
      selectPackedDependencies("@sixtyfold/core", "@sixtyfold/line", "@sixtyfold/themes"),
      ["ES2022", "DOM"],
      `import { LineChart } from "@sixtyfold/line";
import { getLineThemePreset } from "@sixtyfold/themes/line";

declare const chart: LineChart;
chart.updateAppearance(getLineThemePreset("default").line.appearance);
`,
    );

    const stockThemeConsumer = path.join(tempRoot, "stock-theme-consumer");
    await writeConsumer(
      stockThemeConsumer,
      selectPackedDependencies("@sixtyfold/core", "@sixtyfold/stock", "@sixtyfold/themes"),
      ["ES2022", "DOM"],
      `import { StockChart } from "@sixtyfold/stock";
import { getStockThemePreset } from "@sixtyfold/themes/stock";

declare const chart: StockChart;
chart.updateAppearance(getStockThemePreset("default").stock.appearance);
`,
    );

    const nodeConsumer = path.join(tempRoot, "node-consumer");
    await writeConsumer(
      nodeConsumer,
      selectPackedDependencies(
        "@sixtyfold/core",
        "@sixtyfold/line",
        "@sixtyfold/stock",
        "@sixtyfold/ssr",
      ),
      ["ES2022"],
      `import type { MultiSeriesData } from "@sixtyfold/core/data/seriesTypes";
import type { OHLCVData } from "@sixtyfold/stock/ohlcv";
import {
  renderLineChartSSR,
  renderStockChartSSR,
  type SSRCanvas,
  type SSRLineChartOptions,
  type SSRStockChartOptions,
} from "@sixtyfold/ssr";

declare const canvas: SSRCanvas;
declare const lineData: MultiSeriesData;
declare const stockData: OHLCVData;
declare const lineOptions: SSRLineChartOptions;
declare const stockOptions: SSRStockChartOptions;

renderLineChartSSR(canvas, lineData, lineOptions, { width: 800, height: 400 });
renderStockChartSSR(canvas, stockData, stockOptions, { width: 800, height: 400 });
`,
    );
    await writeFile(
      path.join(nodeConsumer, "runtime.mjs"),
      `import { renderLineChartSSR, renderStockChartSSR } from "@sixtyfold/ssr";

let fetchCalls = 0;
const directionAssignments = [];
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("Unexpected SSR fetch");
};

function createCanvas(width = 320, height = 180) {
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(_target, property) {
      if (property === "measureText") return (text) => ({ width: String(text).length * 7 });
      if (property === "createLinearGradient") return () => gradient;
      if (property === "createPattern") return () => null;
      if (property === "getLineDash") return () => [];
      return () => {};
    },
    set(_target, property, value) {
      if (property === "direction") directionAssignments.push(value);
      return true;
    },
  });
  return { width, height, getContext: () => context };
}

const lineCanvas = createCanvas();
const lineDirectionStart = directionAssignments.length;
const lineResult = renderLineChartSSR(
  lineCanvas,
  {
    x: new Float64Array([0, 1, 2, 3]),
    series: [new Float64Array([1, 3, 2, 4])],
    length: 4,
    seriesCount: 1,
  },
  {
    animated: false,
    textDirection: "rtl",
    labels: { top: { text: "مخطط الخطوط", align: "start" } },
    rangeSelector: { visible: false },
  },
  { width: 320, height: 180, createCanvas },
);
if (lineResult !== lineCanvas) throw new Error("Line SSR returned a different canvas");
if (!directionAssignments.slice(lineDirectionStart).includes("rtl")) {
  throw new Error("Packed Line SSR did not apply explicit RTL direction");
}

const stockCanvas = createCanvas();
const stockDirectionStart = directionAssignments.length;
const stockResult = renderStockChartSSR(
  stockCanvas,
  {
    timestamp: new Float64Array([0, 60_000, 120_000]),
    open: new Float64Array([10, 11, 12]),
    high: new Float64Array([12, 13, 14]),
    low: new Float64Array([9, 10, 11]),
    close: new Float64Array([11, 12, 13]),
    volume: new Float64Array([100, 120, 140]),
    length: 3,
  },
  {
    animated: false,
    textDirection: "rtl",
    labels: { top: { text: "مخطط الأسهم", align: "start" } },
    rangeSelector: { visible: false },
  },
  { width: 320, height: 180, createCanvas },
);
if (stockResult !== stockCanvas) throw new Error("Stock SSR returned a different canvas");
if (!directionAssignments.slice(stockDirectionStart).includes("rtl")) {
  throw new Error("Packed Stock SSR did not apply explicit RTL direction");
}
if (fetchCalls !== 0) throw new Error("SSR made " + fetchCalls + " unexpected fetch calls");
console.log("Packed DOM-free SSR runtime rendered line and stock charts without network access.");
`,
    );

    const treeConsumer = path.join(tempRoot, "tree-consumer");
    await writeConsumer(
      treeConsumer,
      {
        "@sixtyfold/core": packedDependencies["@sixtyfold/core"],
        "@sixtyfold/stock": packedDependencies["@sixtyfold/stock"],
      },
      ["ES2022", "DOM"],
      `import { normalizeOHLCVData } from "@sixtyfold/stock/ohlcv";
const normalized = normalizeOHLCVData({
  timestamp: new Float64Array([1, 0]),
  open: new Float64Array([2, 1]),
  high: new Float64Array([3, 2]),
  low: new Float64Array([1, 0]),
  close: new Float64Array([2, 1]),
  volume: new Float64Array([20, 10]),
  length: 2,
});
if (normalized.timestamp[0] !== 0 || normalized.length !== 2) {
  throw new Error("Tree-shaken OHLCV normalization failed");
}
`,
    );
    await writeBrowserPage(treeConsumer);
    await writeFile(
      path.join(treeConsumer, "vite.config.mjs"),
      `export default { build: { modulePreload: { polyfill: false } } };\n`,
    );

    const frameworkConsumer = path.join(tempRoot, "framework-consumer");
    await writeConsumer(
      frameworkConsumer,
      {
        ...selectPackedDependencies(
          "@sixtyfold/core",
          "@sixtyfold/line",
          "@sixtyfold/stock",
          "@sixtyfold/react",
          "@sixtyfold/vue",
          "@sixtyfold/angular",
          "@sixtyfold/svelte",
          "@sixtyfold/solid",
        ),
        "@angular/common": "20.3.26",
        "@angular/core": "20.3.26",
        "@types/react": "19.2.14",
        react: "19.2.7",
        "solid-js": "1.9.14",
        svelte: "5.56.7",
        vue: "3.5.40",
      },
      ["ES2022", "DOM", "DOM.Iterable"],
      `import { SixtyfoldLineChart as ReactLineChart } from "@sixtyfold/react/line";
import { SixtyfoldStockChart as ReactStockChart } from "@sixtyfold/react/stock";
import { SixtyfoldLineChart as VueLineChart } from "@sixtyfold/vue/line";
import { SixtyfoldStockChart as VueStockChart } from "@sixtyfold/vue/stock";
import { SixtyfoldLineChartComponent as AngularLineChart } from "@sixtyfold/angular/line";
import { SixtyfoldStockChartComponent as AngularStockChart } from "@sixtyfold/angular/stock";
import SvelteLineChart from "@sixtyfold/svelte/line";
import SvelteStockChart from "@sixtyfold/svelte/stock";
import { SixtyfoldLineChart as SolidLineChart } from "@sixtyfold/solid/line";
import { SixtyfoldStockChart as SolidStockChart } from "@sixtyfold/solid/stock";

const adapters = [
  ReactLineChart,
  ReactStockChart,
  VueLineChart,
  VueStockChart,
  AngularLineChart,
  AngularStockChart,
  SvelteLineChart,
  SvelteStockChart,
  SolidLineChart,
  SolidStockChart,
];

if (adapters.length !== 10) throw new Error("A framework adapter export is missing");
`,
    );

    const mcpConsumer = path.join(tempRoot, "mcp-consumer");
    await writeConsumer(
      mcpConsumer,
      {
        "@sixtyfold/mcp": packedDependencies["@sixtyfold/mcp"],
      },
      ["ES2022", "DOM"],
      `import {
  generateIntegration,
  searchApiCatalog,
  validateChartOptions,
} from "@sixtyfold/mcp";

const matches = searchApiCatalog("setLODOptions", { packageName: "line", limit: 3 });
if (matches.length === 0) throw new Error("Packed MCP catalog search returned no LOD API");
const recipe = generateIntegration({ component: "line", framework: "react" });
if (!recipe.code.includes("@sixtyfold/react/line")) throw new Error("Packed MCP recipe is incorrect");
if (!validateChartOptions("line", { renderMode: "auto" }).valid) {
  throw new Error("Packed MCP option validation rejected valid options");
}
`,
    );

    for (const consumerDir of [
      browserConsumer,
      lineRuntimeConsumer,
      stockRuntimeConsumer,
      lineThemeConsumer,
      stockThemeConsumer,
      nodeConsumer,
      treeConsumer,
      frameworkConsumer,
      mcpConsumer,
    ]) {
      run(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
        { cwd: consumerDir, stdio: "inherit" },
      );
      const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
      run(tsc, ["-p", path.join(consumerDir, "tsconfig.json")], { stdio: "inherit" });
    }
    await assertPathAbsent(
      path.join(lineThemeConsumer, "node_modules", "@sixtyfold", "stock"),
      "Line-only themes consumer unexpectedly installed @sixtyfold/stock",
    );
    await assertPathAbsent(
      path.join(stockThemeConsumer, "node_modules", "@sixtyfold", "line"),
      "Stock-only themes consumer unexpectedly installed @sixtyfold/line",
    );

    const vite = path.join(repoRoot, "node_modules", ".bin", "vite");
    run(vite, ["build"], { cwd: browserConsumer, stdio: "inherit" });
    const browserBuildFiles = await filesBelow(path.join(browserConsumer, "dist"));
    assert(
      browserBuildFiles.some((file) => /chart\.worker-[^/]+\.js$/u.test(file)),
      "Packed line worker asset was not emitted by the clean Vite consumer",
    );
    assert(
      browserBuildFiles.some((file) => /stock\.worker-[^/]+\.js$/u.test(file)),
      "Packed stock worker asset was not emitted by the clean Vite consumer",
    );
    await runPackedBrowser(browserConsumer);

    run(vite, ["build"], { cwd: lineRuntimeConsumer, stdio: "inherit" });
    await verifyBrowserRuntimeBudget(lineRuntimeConsumer, "line");
    run(vite, ["build"], { cwd: stockRuntimeConsumer, stdio: "inherit" });
    await verifyBrowserRuntimeBudget(stockRuntimeConsumer, "stock");

    run(process.execPath, [path.join(nodeConsumer, "runtime.mjs")], {
      cwd: nodeConsumer,
      stdio: "inherit",
    });

    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const mcp = await import("@sixtyfold/mcp");
const catalog = mcp.getApiCatalog();
if (!/^[0-9a-f]{64}$/.test(catalog.sourceHash) || catalog.packages.length < 10) {
  throw new Error("Packed MCP API catalog is missing or stale");
}
if (mcp.searchApiCatalog("setLODOptions", { packageName: "line" }).length === 0) {
  throw new Error("Packed MCP API search failed");
}
const recipe = mcp.generateIntegration({ component: "stock", framework: "vue" });
if (!recipe.code.includes("@sixtyfold/vue/stock")) throw new Error("Packed MCP recipe failed");
if ("createSixtyfoldMcpServer" in mcp) {
  throw new Error("Packed MCP root unexpectedly exposes its internal SDK server factory");
}
console.log("Packed MCP catalog and guidance passed.");`,
      ],
      { cwd: mcpConsumer, stdio: "inherit" },
    );

    run(vite, ["build"], { cwd: treeConsumer, stdio: "inherit" });
    await verifyTreeShaking(treeConsumer);

    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const themes = await import("@sixtyfold/themes");
const ids = themes.PUBLIC_THEME_IDS;
const unavailableIds = ["draft", "quartz", "mercury", "ivory", "arabicRtl"];
if (ids.length !== 14 || unavailableIds.some((id) => ids.includes(id))) {
  throw new Error("Unexpected public theme IDs");
}
if (!Object.isFrozen(ids) || !Object.isFrozen(themes.PUBLIC_THEMES)) throw new Error("Theme catalog is mutable");
for (const id of ids) {
  const preset = themes.getThemePreset(id);
  if (preset.id !== id || !preset.line?.appearance || !preset.line?.series || !preset.stock?.appearance) {
    throw new Error("Incomplete theme preset: " + id);
  }
  if (!Object.isFrozen(preset) || !Object.isFrozen(preset.line.appearance)) throw new Error("Mutable preset: " + id);
  for (const appearance of [preset.line.appearance, preset.stock.appearance]) {
    if ("labels" in appearance || "ambient" in appearance || "section" in appearance) {
      throw new Error("Content or demo chrome leaked into preset: " + id);
    }
  }
}`,
      ],
      { cwd: browserConsumer, stdio: "inherit" },
    );

    console.log(
      "All Sixtyfold release tarballs pass metadata, notice, package and browser runtime budgets, tree-shaking, no-network, clean-install, browser main/worker, type, and SSR runtime checks.",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
