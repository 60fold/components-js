import path from "node:path";

export const exactCoverageThresholdTargets = [
  "packages/core/src/chart/BaseChart.ts",
  "packages/core/src/rendering/baseRenderer.ts",
  "packages/line/src/lineRenderer.ts",
  "packages/stock/src/stockRenderer.ts",
];

export const coverageIncludePatterns = [
  "packages/core/src/**/*.ts",
  "packages/grid/src/data/**/*.ts",
  "packages/line/src/lineRenderer.ts",
  "packages/line/src/engine/**/*.ts",
  "packages/stock/src/stockRenderer.ts",
  "packages/stock/src/engine/**/*.ts",
];

export const coverageThresholds = {
  statements: 77,
  branches: 68,
  // Function coverage moves in coarse whole-function steps. Keep roughly two
  // percentage points of maintenance headroom so adding one tested feature
  // does not fail solely because it introduces a helper.
  functions: 82,
  lines: 79,
  "packages/core/src/**": {
    statements: 66,
    branches: 55,
    functions: 71,
    lines: 67,
  },
  [exactCoverageThresholdTargets[0]]: {
    statements: 82,
    branches: 69.2,
    functions: 85,
    lines: 83,
  },
  [exactCoverageThresholdTargets[1]]: {
    statements: 58,
    branches: 45,
    functions: 56,
    lines: 61.8,
  },
  [exactCoverageThresholdTargets[2]]: {
    statements: 85,
    branches: 77,
    functions: 90,
    lines: 87,
  },
  [exactCoverageThresholdTargets[3]]: {
    statements: 76,
    branches: 63,
    functions: 90,
    lines: 78,
  },
};

/**
 * Reject Vitest/Istanbul's successful-but-empty coverage report and ensure the
 * files with exact ratchets actually appear in the measured output.
 */
export function validateCoverageSummary(summary, root = process.cwd()) {
  const totalLines = summary?.total?.lines?.total;
  const coveredLines = summary?.total?.lines?.covered;
  if (!Number.isFinite(totalLines) || totalLines <= 0 || !Number.isFinite(coveredLines)) {
    throw new Error("Coverage report contains no measured source files.");
  }

  const normalizedEntries = new Map(
    Object.entries(summary)
      .filter(([name]) => name !== "total")
      .map(([name, value]) => [normalizeCoveragePath(name, root), value]),
  );
  for (const target of exactCoverageThresholdTargets) {
    const entry = normalizedEntries.get(target);
    if (!entry || !Number.isFinite(entry.lines?.total) || entry.lines.total <= 0) {
      throw new Error(`Coverage report is missing exact threshold target: ${target}`);
    }
  }
}

function normalizeCoveragePath(file, root) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  return path.relative(root, absolute).split(path.sep).join("/");
}
