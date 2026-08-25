import type { GridPaintFrame } from "../rendering/paintProtocol.js";

export const GRID_INTERNAL_SURFACE_TELEMETRY: unique symbol = Symbol(
  "sixtyfold.grid.internalSurfaceTelemetry",
);

export type GridSurfaceTelemetrySource = "scroll" | "resize" | "data" | "view" | "api";
export type GridSurfaceTelemetryTargetKind = "active" | "install" | "view" | "edit";

export interface GridSurfaceTelemetryIntentEvent {
  readonly type: "intent";
  readonly intentId: number;
  readonly observedAtMs: number;
  readonly source: GridSurfaceTelemetrySource;
  /** Native scrollport offsets observed with this intent. */
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

interface GridSurfaceTelemetryEventBase {
  readonly surfaceId: number;
  readonly commitToken: string;
  readonly intentId: number;
  readonly intentAtMs: number;
  readonly observedAtMs: number;
  readonly source: GridSurfaceTelemetrySource;
  readonly targetKind: GridSurfaceTelemetryTargetKind;
  readonly columnLayoutRevision: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly pixelRatio: number;
  /** Logical vertical offset represented by this surface. */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** Public, non-overscanned viewport range; ends are exclusive. */
  readonly viewportRowStart: number;
  readonly viewportRowEnd: number;
  readonly viewportColumnStart: number;
  readonly viewportColumnEnd: number;
  /** Exact native scrollport offsets captured by the correlated intent. */
  readonly intentScrollTop: number;
  readonly intentScrollLeft: number;
}

export interface GridSurfaceTelemetryRequestedEvent extends GridSurfaceTelemetryEventBase {
  readonly type: "requested";
}

export interface GridSurfaceTelemetryRuntimeReadyEvent extends GridSurfaceTelemetryEventBase {
  readonly type: "runtime-ready";
  readonly formatDurationMs: number;
  readonly visibleRows: number;
  readonly visibleColumns: number;
  /** Inclusive overscanned frame bounds, or null for an empty frame. */
  readonly firstRenderedRowIndex: number | null;
  readonly lastRenderedRowIndex: number | null;
  readonly firstRenderedColumnIndex: number | null;
  readonly lastRenderedColumnIndex: number | null;
  /** Physical rows in the targeted dataset, before the active view is applied. */
  readonly datasetRowCount: number;
  /** Rows in the targeted active or candidate view. */
  readonly viewRowCount: number;
  readonly datasetColumnCount: number;
  readonly cellCount: number;
  /** Formatted viewport payload size, counted as UTF-16 code units. */
  readonly textCodeUnits: number;
}

export interface GridSurfaceTelemetryPaintPresentedEvent extends GridSurfaceTelemetryEventBase {
  readonly type: "paint-presented";
  readonly paintDurationMs: number;
  readonly paintedCells: number;
  readonly semanticDurationMs: number;
  /** Completion time after the semantic viewport has been replaced. */
  readonly semanticCompleteAtMs: number;
}

export interface GridSurfaceTelemetryPublishedEvent extends GridSurfaceTelemetryEventBase {
  readonly type: "published";
  /** Arrival time of the canonical runtime acknowledgement. */
  readonly runtimeAckAtMs: number;
  readonly latestIntentId: number;
  /** Time from the newest observed intent to completion of public publication work. */
  readonly latestIntentLagMs: number;
}

export type GridSurfaceTelemetryDropReason =
  | "destroyed"
  | "paint-failure"
  | "paint-stale-frame"
  | "paint-unprepared-commit"
  | "presentation-invalidated"
  | "runtime-coalesced"
  | "runtime-failure"
  | "runtime-host"
  | "runtime-stale"
  | "runtime-transport-failure";

export interface GridSurfaceTelemetryDroppedEvent extends GridSurfaceTelemetryEventBase {
  readonly type: "dropped";
  readonly reason: GridSurfaceTelemetryDropReason;
}

export type GridSurfaceTelemetryEvent =
  | GridSurfaceTelemetryIntentEvent
  | GridSurfaceTelemetryRequestedEvent
  | GridSurfaceTelemetryRuntimeReadyEvent
  | GridSurfaceTelemetryPaintPresentedEvent
  | GridSurfaceTelemetryPublishedEvent
  | GridSurfaceTelemetryDroppedEvent;

export type GridSurfaceTelemetrySink = (event: GridSurfaceTelemetryEvent) => void;

/** Package-internal options extension used only by benchmarks and focused tests. */
export interface GridInternalSurfaceTelemetryOptions {
  readonly [GRID_INTERNAL_SURFACE_TELEMETRY]?: GridSurfaceTelemetrySink;
}

export function gridPaintFrameTextCodeUnits(frame: GridPaintFrame): number {
  let total = 0;
  if (frame.rowNumberColumn) {
    total += frame.rowNumberColumn.label.length;
    total += frame.rowNumberColumn.accessibleLabel.length;
  }
  for (const value of frame.rowNumberText ?? []) total += value.length;
  for (const column of frame.columns) {
    total += column.columnId.length;
    total += column.label.length;
  }
  for (const value of frame.cellText) total += value.length;
  return total;
}
