export interface GridPalette {
  readonly background: string;
  readonly alternateBackground: string;
  readonly headerBackground: string;
  readonly line: string;
  readonly text: string;
  readonly mutedText: string;
  readonly accent: string;
  readonly selection: string;
  readonly fontFamily: string;
}

export function readGridPalette(host: HTMLElement): GridPalette {
  const style = getComputedStyle(host);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--sixtyfold-grid-background", "#0c1119"),
    alternateBackground: value("--sixtyfold-grid-row-alternate", "#101720"),
    headerBackground: value("--sixtyfold-grid-header-background", "#121a25"),
    line: value("--sixtyfold-grid-line", "#293641"),
    text: value("--sixtyfold-grid-text", "#f2ead8"),
    mutedText: value("--sixtyfold-grid-muted", "#969188"),
    accent: value("--sixtyfold-grid-accent", "#f4ad32"),
    selection: value("--sixtyfold-grid-selection", "rgb(244 173 50 / 0.16)"),
    fontFamily: value(
      "--sixtyfold-grid-font-family",
      'ui-monospace, "SFMono-Regular", "SF Mono", monospace',
    ),
  };
}
