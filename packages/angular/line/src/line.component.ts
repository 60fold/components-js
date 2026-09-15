import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  PLATFORM_ID,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { isPlatformBrowser } from "@angular/common";
import type { DeepPartial, Viewport } from "@sixtyfold/core";
import {
  LineChart,
  type LineAppearanceOptions,
  type LineChartOptions,
  type LineChartStats,
  type LineDataUpdateOptions,
  type SeriesVisibilityChangeEvent,
} from "@sixtyfold/line";
import { createStatsEmitter, hasViewport, installLineData, type LineData } from "./shared";

export type CanvasAttributes = Record<string, string | number | boolean | null | undefined>;

const MANAGED_CANVAS_ATTRIBUTES = new Set([
  "aria-label",
  "aria-describedby",
  "class",
  "height",
  "role",
  "style",
  "tabindex",
  "width",
]);

/** Standalone Angular component hosting a Sixtyfold line chart. */
@Component({
  selector: "sixtyfold-line-chart",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas
    #canvas
    [class]="canvasClass"
    [attr.aria-label]="resolvedAriaLabel"
    [attr.aria-describedby]="ariaDescribedBy"
    [attr.role]="resolvedCanvasRole"
    [attr.tabindex]="resolvedCanvasTabIndex"
  ></canvas>`,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        min-height: 0;
      }
      canvas {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ],
})
export class SixtyfoldLineChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild("canvas", { static: true }) private canvasRef?: ElementRef<HTMLCanvasElement>;

  @Input() options: LineChartOptions = {};
  @Input() data?: LineData;
  @Input() dataUpdateOptions?: LineDataUpdateOptions;
  @Input() appearance?: DeepPartial<LineAppearanceOptions>;
  @Input() viewport?: Partial<Viewport>;
  /** Leave undefined to inherit the chart's configured `animated` default. */
  @Input() viewportAnimated?: boolean;
  @Input() statsIntervalMs?: number;
  @Input() canvasClass = "";
  @Input() ariaLabel?: string;
  @Input() ariaDescribedBy?: string;
  @Input() canvasRole?: string;
  @Input() canvasTabIndex?: number;
  /** Additional attributes for the canvas host. Chart-owned accessibility,
   *  class, style, and bitmap-size attributes remain controlled above. */
  @Input() canvasAttributes?: CanvasAttributes;

  @Output() readonly chartReady = new EventEmitter<LineChart>();
  /** Reports construction, renderer, and overlay-image failures. */
  @Output() readonly chartError = new EventEmitter<unknown>();
  @Output() readonly stats = createStatsEmitter<LineChartStats>(() => this.syncStatsCallback());
  @Output() readonly seriesVisibilityChange = new EventEmitter<SeriesVisibilityChangeEvent>();

  chart: LineChart | null = null;
  private ready = false;
  private readyNotified = false;
  private rendererFailed = false;
  private destroyed = false;
  private appliedData?: LineData;
  private appliedAppearance?: DeepPartial<LineAppearanceOptions>;
  private appliedViewport?: Partial<Viewport>;
  private statsEnabled?: boolean;
  private statsInterval?: number;
  private reportedRendererError: unknown;
  private readonly appliedCanvasAttributes = new Set<string>();

  private readonly platformId = inject(PLATFORM_ID);

  get resolvedAriaLabel(): string {
    return this.ariaLabel ?? (this.options.interactive === false ? "Chart" : "Interactive chart");
  }

  get resolvedCanvasRole(): string {
    return this.canvasRole ?? (this.options.interactive === false ? "img" : "application");
  }

  get resolvedCanvasTabIndex(): number | null {
    return this.canvasTabIndex ?? (this.options.interactive === false ? null : 0);
  }

  ngAfterViewInit(): void {
    this.syncCanvasAttributes();
    if (isPlatformBrowser(this.platformId)) this.mount();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.syncCanvasAttributes();
    this.syncStatsCallback();
    if (!this.ready) return;
    this.applyReactiveInputs();
  }

  private syncCanvasAttributes(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const next = this.canvasAttributes ?? {};
    for (const name of this.appliedCanvasAttributes) {
      if (!(name in next) || next[name] == null || next[name] === false) {
        canvas.removeAttribute(name);
        this.appliedCanvasAttributes.delete(name);
      }
    }
    for (const [rawName, value] of Object.entries(next)) {
      const name = rawName.toLowerCase();
      if (MANAGED_CANVAS_ATTRIBUTES.has(name) || value == null || value === false) continue;
      canvas.setAttribute(rawName, value === true ? "" : String(value));
      this.appliedCanvasAttributes.add(rawName);
    }
  }

  private mount(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || this.destroyed || this.chart) return;
    let chart: LineChart;
    try {
      chart = new LineChart(canvas, this.options);
    } catch (error) {
      if (!this.destroyed) this.chartError.emit(error);
      return;
    }
    this.chart = chart;
    chart.setRendererErrorCallback((error) => {
      this.rendererFailed = true;
      this.reportedRendererError = error;
      if (!this.destroyed) this.chartError.emit(error);
    });
    chart.setOverlayErrorCallback((error) => {
      if (!this.destroyed) this.chartError.emit(error);
    });
    this.syncStatsCallback();
    chart.setSeriesVisibilityCallback((event) => this.seriesVisibilityChange.emit(event));
    void chart
      .initialize()
      .then(() => {
        if (this.destroyed || this.chart !== chart) return;
        this.ready = true;
        this.applyReactiveInputs();
      })
      .catch((error) => {
        if (!this.destroyed && error !== this.reportedRendererError) {
          this.chartError.emit(error);
        }
      });
  }

  /** Collecting stats costs renderer work, so it stays off until something
   *  subscribes to the `stats` output, and is re-sent only when it changes. */
  private syncStatsCallback(): void {
    const chart = this.chart;
    if (!chart || this.destroyed) return;
    const enabled = this.stats.observed;
    if (enabled === this.statsEnabled && this.statsIntervalMs === this.statsInterval) return;
    this.statsEnabled = enabled;
    this.statsInterval = this.statsIntervalMs;
    chart.setStatsCallback(enabled ? (value) => this.stats.emit(value) : null, {
      intervalMs: this.statsIntervalMs,
    });
  }

  /** Installs every reactive input in a single engine update. Each dataset
   *  object is applied at most once. Worker mode transfers its buffers;
   *  identity tracking also prevents duplicate installs in main-thread mode. */
  private applyReactiveInputs(): void {
    const chart = this.chart;
    if (!chart || !this.ready || this.destroyed || this.rendererFailed) return;
    try {
      chart.batch(() => {
        if (this.data && this.data !== this.appliedData) {
          installLineData(chart, this.data, this.dataUpdateOptions);
          this.appliedData = this.data;
        }
        if (this.appearance && this.appearance !== this.appliedAppearance) {
          chart.updateAppearance(this.appearance);
          this.appliedAppearance = this.appearance;
        }
        if (hasViewport(this.viewport) && this.viewport !== this.appliedViewport) {
          chart.setViewport(this.viewport, { animated: this.viewportAnimated });
          this.appliedViewport = this.viewport;
        }
      });
    } catch (error) {
      if (!this.destroyed && error !== this.reportedRendererError) this.chartError.emit(error);
      return;
    }
    if (!this.destroyed && !this.rendererFailed && this.chart === chart && !this.readyNotified) {
      this.readyNotified = true;
      this.chartReady.emit(chart);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.ready = false;
    this.chart?.destroy();
    this.chart = null;
  }
}
