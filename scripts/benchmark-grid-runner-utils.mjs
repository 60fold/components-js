import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const ignoredTreeEntries = new Set(["node_modules", "dist", "coverage", "cache"]);

export async function hashCanonicalTree(roots) {
  const entries = [];
  for (const descriptor of roots) {
    const metadata = await stat(descriptor.root);
    if (metadata.isFile()) {
      entries.push({ absolute: descriptor.root, relative: descriptor.prefix });
    } else if (metadata.isDirectory()) {
      await collectTreeFiles(descriptor.root, descriptor.root, descriptor.prefix, entries);
    } else {
      throw new Error(`Cannot hash non-file tree entry ${descriptor.root}.`);
    }
  }
  entries.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const entry of entries) {
    const bytes = await readFile(entry.absolute);
    hash.update(entry.relative.split(path.sep).join("/"), "utf8");
    hash.update("\0");
    hash.update(String(bytes.byteLength), "utf8");
    hash.update("\0");
    hash.update(bytes);
    totalBytes += bytes.byteLength;
  }
  return {
    sha256: hash.digest("hex"),
    fileCount: entries.length,
    totalBytes,
    roots: roots.map((entry) => entry.prefix),
  };
}

async function collectTreeFiles(base, directory, prefix, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ignoredTreeEntries.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectTreeFiles(base, absolute, prefix, output);
    else if (entry.isFile()) {
      const relative = path.relative(base, absolute).split(path.sep).join("/");
      output.push({ absolute, relative: relative ? `${prefix}/${relative}` : prefix });
    }
  }
}

export function createStaticServer(siteRoot) {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
      const resolved = path.resolve(siteRoot, relative);
      if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(resolved);
      response.writeHead(200, {
        "content-type": contentType(resolved),
        "cache-control": "no-store",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
  });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".map") || file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export async function resolveGridPackageRoot(candidate) {
  for (const possible of [candidate, path.join(candidate, "packages/grid")]) {
    try {
      const index = await stat(path.join(possible, "src/index.ts"));
      const implementation = await stat(path.join(possible, "src/Grid.ts"));
      if (index.isFile() && implementation.isFile()) return possible;
    } catch {
      // Try the next supported repository shape.
    }
  }
  throw new Error(`${candidate} is neither a Grid package nor a repository containing one.`);
}

export function git(cwd, arguments_) {
  const result = spawnSync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function captureOutcome(outcomes, identity, operation) {
  const startedAt = new Date();
  const started = performance.now();
  try {
    const value = await operation();
    outcomes.push({
      ...identity,
      status: "completed",
      startedAt: startedAt.toISOString(),
      durationMs: performance.now() - started,
    });
    return { ok: true, value };
  } catch (error) {
    const status = classifyAttemptError(error);
    outcomes.push({
      ...identity,
      status,
      startedAt: startedAt.toISOString(),
      durationMs: performance.now() - started,
      error: serializeError(error),
    });
    return { ok: false, error, status };
  }
}

function classifyAttemptError(error) {
  let current = error;
  while (current && typeof current === "object") {
    const detail = `${current.name ?? ""} ${current.message ?? ""} ${current.signal ?? ""}`;
    if (/out of memory|heap limit|allocation failed|\boom\b/i.test(detail)) return "oom";
    if (/unresponsive|not responding|heartbeat/i.test(detail)) return "unresponsive";
    if (
      /page crashed|browser.*(?:closed|disconnected)|target (?:page|context|browser).*closed|\bcrash(?:ed)?\b|SIG(?:ABRT|BUS|ILL|SEGV)/i.test(
        detail,
      )
    ) {
      return "crash";
    }
    if (current.name === "TimeoutError" || /timed?\s*out|timeout/i.test(detail)) return "timeout";
    current = current.cause;
  }
  return "error";
}

function serializeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

export function outcomeFailure(label, result) {
  const detail = result.error instanceof Error ? result.error.message : String(result.error);
  return `${label}: ${result.status}: ${detail}`;
}

export function list(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function integerList(value, label) {
  const values = list(value).map((entry) => positiveInteger(entry, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique.`);
  return values;
}

export function validateList(values, accepted, label) {
  if (values.length === 0 || values.some((value) => !accepted.includes(value))) {
    throw new Error(`${label} must contain only ${accepted.join(", ")}.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates.`);
}

export function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be positive.`);
  return parsed;
}

export function nonNegativeNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be non-negative.`);
  return parsed;
}

export function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be positive.`);
  return parsed;
}

export function boundedNumber(value, flag, exclusiveMinimum, inclusiveMaximum) {
  const parsed = Number(value);
  if (!(parsed > exclusiveMinimum && parsed <= inclusiveMaximum)) {
    throw new Error(`${flag} must be in (${exclusiveMinimum}, ${inclusiveMaximum}].`);
  }
  return parsed;
}

export function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1)];
}

export function maximum(values) {
  return values.length === 0 ? null : Math.max(...values);
}

export function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function browserDistribution(browser) {
  if (browser === "safari") {
    return "Installed branded Apple Safari driven by the operating system /usr/bin/safaridriver";
  }
  if (browser === "firefox-installed") {
    return "Installed branded Mozilla Firefox driven by a separately configured geckodriver binary";
  }
  if (browser === "webkit") return "Playwright-bundled WebKit; not branded Safari";
  if (browser === "firefox") return "Playwright-patched Firefox; not installed branded Firefox";
  return "Playwright-bundled Chromium";
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
