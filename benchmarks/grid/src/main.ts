import type {
  BenchmarkWorkerOutput,
  BrowserGridBenchmarkResult,
  GridBenchmarkCaseId,
  GridBenchmarkConfiguration,
  GridBenchmarkProfileId,
} from "./contracts";
import { buildBenchmarkDataset } from "./profiles";

const PRODUCTION_CHUNK_SIZE = 1_048_576;
const status = document.querySelector<HTMLOutputElement>("#status");
const configuration = parseConfiguration(new URL(location.href).searchParams);

void execute().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  setStage(`failed: ${normalized.message}`);
  globalThis.__SIXTYFOLD_GRID_BENCHMARK_RESULT__ = {
    error: normalized.stack ?? normalized.message,
  } as unknown as BrowserGridBenchmarkResult;
});

async function execute(): Promise<void> {
  setStage(`generating ${configuration.profile}`);
  const dataset = buildBenchmarkDataset(configuration.profile, configuration.rowScale);

  const worker = new Worker(new URL("./benchmark.worker.ts", import.meta.url), { type: "module" });
  const result = await new Promise<BrowserGridBenchmarkResult>((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessageerror = () =>
      reject(new Error("Benchmark worker message deserialization failed."));
    worker.onmessage = (event: MessageEvent<BenchmarkWorkerOutput>) => {
      void handleWorkerMessage(event.data).catch(reject);
    };

    const handleWorkerMessage = async (message: BenchmarkWorkerOutput): Promise<void> => {
      if (message.type === "error") {
        reject(new Error(message.stack ?? message.message));
        return;
      }
      if (message.type === "stage") {
        setStage(message.stage);
        return;
      }
      if (message.type === "builder-cancellation-armed") {
        setStage(
          `${configuration.profile}/builder-cancellation/${message.sortProgress.completed}-of-${message.sortProgress.total}`,
        );
        const supersede = (): void => {
          worker.postMessage({
            type: "supersede",
            token: message.token,
            dispatchedAtEpochMs: epochNow(),
          });
        };
        if (message.delayMs === 0) supersede();
        else setTimeout(supersede, message.delayMs);
        return;
      }
      if (message.type === "ready") {
        setStage(`${configuration.profile}/running`);
        worker.postMessage({ type: "run" });
        return;
      }

      resolve({
        ...message.result,
        configuration,
      });
    };

    setStage(`transferring ${formatBytes(dataset.transfer.bytes)}`);
    worker.postMessage(
      { type: "init", configuration, dataset },
      { transfer: [...dataset.transfer.buffers] },
    );
  });
  worker.terminate();
  globalThis.__SIXTYFOLD_GRID_BENCHMARK_RESULT__ = result;
  setStage(result.failures.length === 0 ? "complete" : "complete-with-failures");
}

function parseConfiguration(parameters: URLSearchParams): GridBenchmarkConfiguration {
  const profile = parameters.get("profile") ?? "narrow-10m";
  if (profile !== "narrow-10m" && profile !== "wide-1m") {
    throw new Error(`Unknown profile ${JSON.stringify(profile)}.`);
  }
  const cases = list(
    parameters.get("cases") ??
      "filter-numeric,filter-category,sort-1-key,filter-sort-3-key-25pct,builder-cancellation-replacement",
  ) as GridBenchmarkCaseId[];
  const validCases = new Set([
    "filter-numeric",
    "filter-category",
    "sort-1-key",
    "filter-sort-3-key-25pct",
    "builder-cancellation-replacement",
  ]);
  if (cases.length === 0 || cases.some((caseId) => !validCases.has(caseId))) {
    throw new Error("cases contains an unknown benchmark case.");
  }
  if (cases.includes("builder-cancellation-replacement") && !cases.includes("filter-numeric")) {
    throw new Error(
      "builder-cancellation-replacement requires filter-numeric as its replacement reference.",
    );
  }
  const cadenceMode = parameters.get("cadenceMode") ?? "production";
  if (cadenceMode !== "production" && cadenceMode !== "custom") {
    throw new Error("cadenceMode must be production or custom.");
  }
  const chunkSize = positiveInteger(
    parameters.get("chunkSize") ?? String(PRODUCTION_CHUNK_SIZE),
    "chunkSize",
  );
  return {
    profile: profile as GridBenchmarkProfileId,
    rowScale: positiveNumber(parameters.get("rowScale") ?? "1", "rowScale"),
    repetitions: positiveInteger(parameters.get("repetitions") ?? "3", "repetitions"),
    cases,
    cancellationDelayMs: nonNegativeNumber(
      parameters.get("cancellationDelayMs") ?? "5",
      "cancellationDelayMs",
    ),
    chunkSize,
    cadenceMode,
    cadenceDescription:
      parameters.get("cadenceDescription") ??
      (cadenceMode === "production"
        ? `production: zero-delay worker task after at most ${PRODUCTION_CHUNK_SIZE.toLocaleString("en-US")} processed rows`
        : `custom: zero-delay worker task after at most ${chunkSize.toLocaleString("en-US")} processed rows`),
  };
}

function setStage(stage: string): void {
  globalThis.__SIXTYFOLD_GRID_BENCHMARK_STAGE__ = stage;
  if (status) status.value = stage;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!(parsed > 0 && parsed <= 1)) throw new Error(`${label} must be in (0, 1].`);
  return parsed;
}

function nonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}
