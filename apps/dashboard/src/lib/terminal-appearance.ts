import type { ITheme, Terminal } from "@xterm/xterm";
import { APPEARANCE_CHANGED } from "./appearance-runtime";
/** xterm paints its own surface, so resolve the app's CSS tokens for it too.
 *  Computed colors normalize HSL/alpha tokens to the RGB form xterm accepts. */
export function readTerminalTheme(element: HTMLElement | null): ITheme {
  element = element ?? document.documentElement;
  const probe = document.createElement("span");
  probe.hidden = true;
  element.append(probe);
  const color = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const background = color("--th-card-on-page");
  const foreground = color("--foreground");
  const red = color("--danger");
  const green = color("--success");
  const yellow = color("--warning");
  const blue = color("--info");
  const magenta = color("--th-terminal-magenta");
  const cyan = color("--th-terminal-cyan");
  const theme: ITheme = {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: color("--info-bg"),
    selectionForeground: foreground,
    scrollbarSliderBackground: color("--th-on-16"),
    scrollbarSliderHoverBackground: color("--th-on-25"),
    scrollbarSliderActiveBackground: color("--th-on-30"),
    black: color("--th-terminal-black"),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: color("--th-terminal-white"),
    brightBlack: color("--muted-foreground"),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
  };
  probe.remove();
  return theme;
}

/** Update a mounted terminal without closing its PTY or losing scrollback. */
export function observeTerminalAppearance(
  terminal: Terminal,
  element: HTMLElement,
  fit?: () => void,
) {
  const original = {
    fontFamily: terminal.options.fontFamily,
    fontSize: terminal.options.fontSize,
    lineHeight: terminal.options.lineHeight,
  };
  let frame = 0;
  const update = () => {
    terminal.options.theme = readTerminalTheme(element);
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--font-mono)";
    element.append(probe);
    const fontFamily = getComputedStyle(probe).fontFamily || original.fontFamily;
    probe.remove();
    const style = getComputedStyle(element);
    const fontSize =
      parseFloat(style.getPropertyValue("--appearance-mono-size")) || original.fontSize;
    const lineHeight =
      parseFloat(style.getPropertyValue("--appearance-line-height")) || original.lineHeight;
    const resized =
      terminal.options.fontFamily !== fontFamily ||
      terminal.options.fontSize !== fontSize ||
      terminal.options.lineHeight !== lineHeight;
    if (resized) {
      terminal.options.fontFamily = fontFamily;
      terminal.options.fontSize = fontSize;
      terminal.options.lineHeight = lineHeight;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit?.());
    }
  };
  update();
  window.addEventListener(APPEARANCE_CHANGED, update);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener(APPEARANCE_CHANGED, update);
  };
}
