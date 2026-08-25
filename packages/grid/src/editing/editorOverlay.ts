import type { CellScalar, GridColumnKind } from "../types.js";

export type GridEditorNavigation = "stay" | "next" | "previous";

export interface GridEditorOverlayOptions {
  readonly container: HTMLElement;
  readonly columnId: string;
  readonly accessibleLabel?: string;
  readonly nullLabel?: string;
  readonly trueLabel?: string;
  readonly falseLabel?: string;
  readonly rowNumber: number;
  readonly kind: GridColumnKind;
  readonly nullable: boolean;
  readonly initialValue: CellScalar | null;
  readonly categoryValues?: readonly string[];
  readonly onCommit: (value: GridEditorRawValue, navigation: GridEditorNavigation) => void;
  readonly onCancel: () => void;
}

export interface GridEditorRawValue {
  readonly raw: string;
  readonly explicitNull: boolean;
}

export interface GridEditorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

let nextEditorId = 0;

/** One accessible DOM editor positioned over a renderer-confirmed raw cell. */
export class GridEditorOverlay {
  readonly element: HTMLDivElement;
  readonly control: HTMLInputElement | HTMLSelectElement;
  private readonly error: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly nullButton: HTMLButtonElement | null;
  private readonly onCommit: GridEditorOverlayOptions["onCommit"];
  private readonly onCancel: GridEditorOverlayOptions["onCancel"];
  private explicitNull: boolean;
  private composing = false;
  private disabled = false;

  constructor(options: GridEditorOverlayOptions) {
    const id = `sixtyfold-grid-editor-${++nextEditorId}`;
    this.onCommit = options.onCommit;
    this.onCancel = options.onCancel;
    this.explicitNull = options.initialValue === null;

    const element = document.createElement("div");
    element.dataset.gridEditor = "";
    element.dataset.gridEditState = "editing";
    Object.assign(element.style, {
      position: "absolute",
      zIndex: "4",
      boxSizing: "border-box",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      alignItems: "stretch",
      pointerEvents: "auto",
      color: "var(--sixtyfold-grid-editor-text, #f8fafc)",
      background: "var(--sixtyfold-grid-editor-background, #111827)",
      border: "2px solid var(--sixtyfold-grid-editor-focus, #60a5fa)",
      borderRadius: "3px",
      boxShadow: "0 8px 24px rgb(0 0 0 / 32%)",
    });

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = `${options.accessibleLabel ?? options.columnId}, row ${options.rowNumber}`;
    visuallyHide(label);

    const control = createControl(options);
    control.id = id;
    control.dataset.gridEditorControl = "";
    Object.assign(control.style, {
      minWidth: "0",
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
      padding: "0 10px",
      border: "0",
      borderRadius: "1px",
      outline: "none",
      color: "inherit",
      background: "transparent",
      font: "500 13px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    });

    const error = document.createElement("div");
    error.id = `${id}-error`;
    error.dataset.gridEditorError = "";
    error.setAttribute("role", "alert");
    Object.assign(error.style, {
      position: "absolute",
      left: "0",
      top: "calc(100% + 4px)",
      maxWidth: "min(360px, calc(100vw - 24px))",
      padding: "6px 8px",
      borderRadius: "3px",
      color: "#fff",
      background: "#991b1b",
      font: "600 12px/1.35 system-ui, sans-serif",
      boxShadow: "0 6px 18px rgb(0 0 0 / 28%)",
      display: "none",
    });
    control.setAttribute("aria-describedby", error.id);

    const status = document.createElement("div");
    status.dataset.gridEditorStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    visuallyHide(status);

    let nullButton: HTMLButtonElement | null = null;
    if (options.nullable && !(control instanceof HTMLSelectElement)) {
      nullButton = document.createElement("button");
      nullButton.type = "button";
      nullButton.dataset.gridEditorNull = "";
      nullButton.setAttribute("aria-label", options.nullLabel ?? "Set null");
      nullButton.title = options.nullLabel ?? "Set null";
      nullButton.textContent = "∅";
      Object.assign(nullButton.style, {
        width: "32px",
        border: "0",
        borderLeft: "1px solid rgb(148 163 184 / 38%)",
        color: "inherit",
        background: "transparent",
        cursor: "pointer",
      });
      nullButton.addEventListener("click", () => {
        if (this.disabled) return;
        this.explicitNull = !this.explicitNull;
        element.dataset.gridEditorNullValue = String(this.explicitNull);
        nullButton!.setAttribute("aria-pressed", String(this.explicitNull));
        control.focus({ preventScroll: true });
      });
    }

    control.addEventListener("input", () => {
      this.explicitNull = false;
      element.dataset.gridEditorNullValue = "false";
      nullButton?.setAttribute("aria-pressed", "false");
      this.clearError();
    });
    control.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    control.addEventListener("compositionend", () => {
      this.composing = false;
    });
    control.addEventListener("pointerdown", (event) => {
      if (this.disabled) event.preventDefault();
    });
    control.addEventListener("keydown", (event) => this.handleKeyDown(event as KeyboardEvent));

    element.append(label, control);
    if (nullButton) element.append(nullButton);
    element.append(error, status);
    element.dataset.gridEditorNullValue = String(this.explicitNull);
    nullButton?.setAttribute("aria-pressed", String(this.explicitNull));
    options.container.append(element);

    this.element = element;
    this.control = control;
    this.error = error;
    this.status = status;
    this.nullButton = nullButton;
  }

  focus(): void {
    this.control.focus({ preventScroll: true });
    if (this.control instanceof HTMLInputElement) this.control.select();
  }

  position(rect: GridEditorRect): void {
    Object.assign(this.element.style, {
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.max(1, Math.round(rect.width))}px`,
      height: `${Math.max(1, Math.round(rect.height))}px`,
    });
  }

  value(): GridEditorRawValue {
    if (this.control instanceof HTMLSelectElement && this.control.value === NULL_VALUE) {
      return { raw: "", explicitNull: true };
    }
    return { raw: this.control.value, explicitNull: this.explicitNull };
  }

  canCommit(): boolean {
    return !this.composing && !this.disabled;
  }

  setStatus(state: "editing" | "pending" | "committing" | "applying", message: string): void {
    this.element.dataset.gridEditState = state;
    this.status.textContent = message;
    this.disabled = state !== "editing";
    const afterLease = state === "committing" || state === "applying";
    this.control.disabled = afterLease;
    if (this.control instanceof HTMLInputElement) this.control.readOnly = state === "pending";
    if (state === "pending") this.control.setAttribute("aria-disabled", "true");
    else this.control.removeAttribute("aria-disabled");
    if (this.nullButton) this.nullButton.disabled = this.disabled;
    this.element.setAttribute("aria-busy", String(this.disabled));
  }

  setError(message: string): void {
    this.setStatus("editing", "");
    this.error.textContent = message;
    this.error.style.display = "block";
    this.control.setAttribute("aria-invalid", "true");
    this.focus();
  }

  setReconcileRequired(message: string): void {
    this.disabled = true;
    this.control.disabled = true;
    if (this.nullButton) this.nullButton.disabled = true;
    this.element.dataset.gridEditState = "reconcile-required";
    this.element.setAttribute("aria-busy", "false");
    this.error.textContent = message;
    this.error.style.display = "block";
    this.control.setAttribute("aria-invalid", "true");
  }

  clearError(): void {
    this.error.textContent = "";
    this.error.style.display = "none";
    this.control.removeAttribute("aria-invalid");
  }

  destroy(): void {
    this.element.remove();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.onCancel();
      return;
    }
    if (this.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const navigation = event.key === "Tab" ? (event.shiftKey ? "previous" : "next") : "stay";
    if (event.key !== "Enter" && event.key !== "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    this.onCommit(this.value(), navigation);
  }
}

const NULL_VALUE = "\u0000sixtyfold:null";

function createControl(options: GridEditorOverlayOptions): HTMLInputElement | HTMLSelectElement {
  if (options.kind === "boolean" || options.kind === "category") {
    const select = document.createElement("select");
    if (options.nullable) appendOption(select, NULL_VALUE, options.nullLabel ?? "Null");
    if (options.kind === "boolean") {
      appendOption(select, "true", options.trueLabel ?? "True");
      appendOption(select, "false", options.falseLabel ?? "False");
    } else {
      for (const value of options.categoryValues ?? []) appendOption(select, value, value);
    }
    select.value = options.initialValue === null ? NULL_VALUE : String(options.initialValue);
    return select;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = options.kind === "text";
  if (options.kind === "integer") input.inputMode = "numeric";
  else if (options.kind === "number") input.inputMode = "decimal";
  input.value = options.initialValue === null ? "" : String(options.initialValue);
  return input;
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function visuallyHide(element: HTMLElement): void {
  Object.assign(element.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: "0",
  });
}
