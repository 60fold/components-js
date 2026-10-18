import type { GridColumnData, GridData } from "@grid-benchmark/types";
import type { GridBenchmarkDataset } from "../../grid/src/contracts";
import { buildBenchmarkDataset } from "../../grid/src/profiles";
import type {
  BrowserGridSummaryResult,
  GridSummaryColumnScopeId,
  GridSummaryConfiguration,
  GridSummaryViewId,
  GridSummaryWorkerOutput,
} from "./contracts";

const PRODUCTION_CHUNK_SIZE = 1_048_576;
const status = document.querySelector<HTMLOutputElement>("#status");
const configuration = parseConfiguration(new URL(location.href).searchParams);

void execute().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  setStage(`failed: ${normalized.message}`);
  globalThis.__SIXTYFOLD_GRID_SUMMARY_RESULT__ = {
    error: normalized.stack ?? normalized.message,
  };
});

async function execute(): Promise<void> {
  setStage("generating-summary-specific-narrow-10m");
  const dataset = addSummaryFidelityValues(
    buildBenchmarkDataset("narrow-10m", configuration.rowScale),
  );

  const worker = new Worker(new URL("./benchmark.worker.ts", import.meta.url), { type: "module" });
  const result = await new Promise<BrowserGridSummaryResult>((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessageerror = () =>
      reject(new Error("Summary worker message deserialization failed."));
    worker.onmessage = (event: MessageEvent<GridSummaryWorkerOutput>) => {
      void handle(event.data).catch(reject);
    };

    const handle = async (message: GridSummaryWorkerOutput): Promise<void> => {
      if (message.type === "error") {
        reject(new Error(message.stack ?? message.message));
        return;
      }
      if (message.type === "stage") {
        setStage(message.stage);
        return;
      }
      if (message.type === "cancellation-armed") {
        setStage(`cancelling-${message.kind}-${message.progress}-of-${message.total}`);
        const dispatch = (): void => {
          worker.postMessage({
            type: "cancel",
            token: message.token,
            dispatchedAtEpochMs: epochNow(),
          });
        };
        if (message.delayMs === 0) dispatch();
        else setTimeout(dispatch, message.delayMs);
        return;
      }
      if (message.type === "ready") {
        worker.postMessage({ type: "run" });
        return;
      }

      resolve({
        ...message.result,
        configuration,
      });
    };

    setStage(`transferring-${dataset.transfer.bytes}-bytes`);
    worker.postMessage(
      { type: "init", configuration, dataset },
      { transfer: [...dataset.transfer.buffers] },
    );
  });

  worker.terminate();
  globalThis.__SIXTYFOLD_GRID_SUMMARY_RESULT__ = result;
  setStage(result.failures.length === 0 ? "complete" : "complete-with-failures");
}

/**
 * Retains the canonical profile's shapes, dictionaries, and view cases while
 * adding deterministic fidelity-matrix values solely for this benchmark.
 */
function addSummaryFidelityValues(source: GridBenchmarkDataset): GridBenchmarkDataset {
  const fidelityColumnIds = new Set([
    "value0",
    "value1",
    "value2",
    "value3",
    "category0",
    "category1",
  ]);
  const addedBuffers: ArrayBuffer[] = [];
  let nullCount = 0;
  const columns = source.data.columns.map((column, columnIndex) => {
    if (!fidelityColumnIds.has(column.schema.id)) return column;
    const validity = new Uint8Array(Math.ceil(source.data.length / 8));
    validity.fill(0xff);
    const prime = [997, 991, 983, 977, 971, 967][columnIndex - 1] ?? 997;
    const offset = (columnIndex * 37) % prime;
    for (let row = offset; row < source.data.length; row += prime) {
      if (row < 16) continue;
      clearBit(validity, row);
      nullCount++;
    }
    // Rows used for deterministic edge/special values must remain non-null.
    for (let row = 0; row < Math.min(16, source.data.length); row++) setBit(validity, row);
    const remainder = source.data.length & 7;
    if (remainder !== 0 && validity.length > 0) {
      validity[validity.length - 1] = validity[validity.length - 1]! & ((1 << remainder) - 1);
    }
    addedBuffers.push(validity.buffer);

    if (column.data.kind === "number") {
      installNumericSpecials(column.data, columnIndex, source.data.length);
    } else if (column.data.kind === "category") {
      installAdversarialCategoryPrefix(column.data, source.data.length);
    }
    return {
      schema: { ...column.schema, nullable: true, editable: true },
      data: {
        ...column.data,
        validity: { bits: { view: validity, ownership: "transfer" as const } },
      },
    } as GridData["columns"][number];
  });
  const data: GridData = { ...source.data, columns };
  const bytes =
    source.transfer.bytes + addedBuffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  return {
    ...source,
    data,
    profile: {
      ...source.profile,
      nullDensity:
        source.data.length === 0 ? 0 : nullCount / (source.data.length * fidelityColumnIds.size),
      installedTypedArrayBytes: bytes,
      syntheticGeneratedTypedArrayBytes: bytes,
      notes: [
        ...source.profile.notes,
        "Summary benchmark only: four numeric and two category columns carry deterministic Arrow-compatible null validity bitmaps.",
        "Summary benchmark only: numeric columns include NaN, positive/negative infinity, signed zero, and tied finite extrema; category prefixes force adversarial first-distinct order over shuffled dictionaries.",
      ],
    },
    transfer: {
      buffers: [...source.transfer.buffers, ...addedBuffers],
      bytes,
    },
  };
}

function installNumericSpecials(
  data: Extract<GridColumnData, { kind: "number" }>,
  salt: number,
  rows: number,
): void {
  const values = data.values.view;
  if (rows > 0) values[0] = Number.NaN;
  if (rows > 1) values[1] = Number.POSITIVE_INFINITY;
  if (rows > 2) values[2] = Number.NEGATIVE_INFINITY;
  if (rows > 3) values[3] = 0;
  if (rows > 4) values[4] = -0;
  const finiteMinimum = -1_000_000_000_000 - salt;
  const finiteMaximum = 1_000_000_000_000 + salt;
  if (rows > 5) values[5] = finiteMinimum;
  if (rows > 6) values[6] = finiteMinimum;
  if (rows > 7) values[7] = finiteMaximum;
  if (rows > 8) values[8] = finiteMaximum;
}

function installAdversarialCategoryPrefix(
  data: Extract<GridColumnData, { kind: "category" }>,
  rows: number,
): void {
  const codes = data.codes.view;
  let maximumCode = 0;
  for (let row = 0; row < Math.min(rows, 4_096); row++)
    maximumCode = Math.max(maximumCode, Number(codes[row]));
  const prefix = maximumCode >= 31 ? [31, 0, 30, 1, 29, 2, 28, 3] : [6, 0, 5, 1, 4, 2, 3, 0];
  for (let index = 0; index < Math.min(rows, prefix.length); index++) {
    codes[index] = prefix[index]!;
  }
}

function setBit(bits: Uint8Array, row: number): void {
  bits[row >>> 3] = bits[row >>> 3]! | (1 << (row & 7));
}

function clearBit(bits: Uint8Array, row: number): void {
  bits[row >>> 3] = bits[row >>> 3]! & ~(1 << (row & 7));
}

function parseConfiguration(parameters: URLSearchParams): GridSummaryConfiguration {
  const blockSizes = integerList(parameters.get("blockSizes") ?? "256", "blockSizes");
  const views = stringList(
    parameters.get("views") ?? "identity,full-sort,filtered-sort-25pct",
  ) as GridSummaryViewId[];
  const scopes = stringList(
    parameters.get("columnScopes") ?? "two-column,all-eligible",
  ) as GridSummaryColumnScopeId[];
  const validViews = new Set<GridSummaryViewId>(["identity", "full-sort", "filtered-sort-25pct"]);
  const validScopes = new Set<GridSummaryColumnScopeId>(["two-column", "all-eligible"]);
  if (views.length === 0 || views.some((view) => !validViews.has(view)))
    throw new Error("Invalid views.");
  if (scopes.length === 0 || scopes.some((scope) => !validScopes.has(scope)))
    throw new Error("Invalid columnScopes.");
  return {
    profile: "narrow-10m",
    rowScale: positiveNumber(parameters.get("rowScale") ?? "1", "rowScale"),
    sampleIndex: nonNegativeInteger(parameters.get("sampleIndex") ?? "0", "sampleIndex"),
    caseOrderRotation: nonNegativeInteger(
      parameters.get("caseOrderRotation") ?? "0",
      "caseOrderRotation",
    ),
    repetitions: positiveInteger(parameters.get("repetitions") ?? "2", "repetitions"),
    blockSizes,
    views,
    columnScopes: scopes,
    bandCount: positiveInteger(parameters.get("bandCount") ?? "2048", "bandCount"),
    performanceQueryCount: positiveInteger(
      parameters.get("performanceQueryCount") ?? "2048",
      "performanceQueryCount",
    ),
    oracleRangeCount: positiveInteger(
      parameters.get("oracleRangeCount") ?? "32",
      "oracleRangeCount",
    ),
    chunkSize: positiveInteger(
      parameters.get("chunkSize") ?? String(PRODUCTION_CHUNK_SIZE),
      "chunkSize",
    ),
    cancellationDelayMs: nonNegativeNumber(
      parameters.get("cancellationDelayMs") ?? "0",
      "cancellationDelayMs",
    ),
  };
}

function stringList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function integerList(value: string, label: string): number[] {
  const values = stringList(value).map((entry) => positiveInteger(entry, label));
  if (values.length === 0 || new Set(values).size !== values.length)
    throw new Error(`${label} must be unique and non-empty.`);
  return values;
}

function positiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return number;
}

function positiveNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1)
    throw new Error(`${label} must be in (0, 1].`);
  return number;
}

function nonNegativeNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be non-negative.`);
  return number;
}

function nonNegativeInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be a non-negative integer.`);
  return number;
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function setStage(value: string): void {
  globalThis.__SIXTYFOLD_GRID_SUMMARY_STAGE__ = value;
  if (status) status.value = value;
}
