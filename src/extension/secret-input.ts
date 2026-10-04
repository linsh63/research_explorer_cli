import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

export async function promptConfirmationToken(ctx: ExtensionContext): Promise<string | null> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Confirmation tokens can only be entered in the interactive TUI hidden-input dialog.", "error");
    return null;
  }
  return (await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => new SecretInput(tui, theme, done),
    { overlay: true, overlayOptions: { anchor: "center", width: 64, maxHeight: 8 } },
  )) ?? null;
}

export class SecretInput implements Component, Focusable {
  focused = true;
  private value = "";

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (value: string | null) => void,
  ) {}

  render(width: number): string[] {
    const available = Math.max(1, width - 4);
    const visible = "•".repeat(Math.min([...this.value].length, available));
    const cursor = this.focused ? CURSOR_MARKER : "";
    return [
      this.theme.fg("accent", "Confirmation token"),
      this.theme.fg("dim", "Input is masked and is sent once directly to Core."),
      `> ${visible}${cursor}`,
      this.theme.fg("dim", "Enter to submit · Esc to cancel"),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) {
      const token = this.value;
      this.value = "";
      this.done(token || null);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.value = "";
      this.done(null);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.value = [...this.value].slice(0, -1).join("");
    } else {
      const printable = [...data].filter((character) => character >= " " && character !== "\u007f").join("");
      this.value = `${this.value}${printable}`.slice(0, 4096);
    }
    this.tui.requestRender();
  }

  invalidate(): void {}
}
