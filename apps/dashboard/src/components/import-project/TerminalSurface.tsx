"use client";

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ITheme, Terminal } from "@xterm/xterm";
import { useTheme } from "@/components/theme-provider";
import { useLogTerminal } from "@/components/terminal/LogTerminalContext";
import "@xterm/xterm/css/xterm.css";

type TerminalTheme = "light" | "dark";

interface TerminalSurfaceProps {
  terminalRef?: MutableRefObject<any | null>;
  onReady?: (terminal: any) => void;
  className?: string;
  theme?: TerminalTheme;
  /** Only the visible terminal supplies its containing log panel's actions. */
  active?: boolean;
}

/** xterm paints its own surface, so resolve the app's CSS tokens for it too.
 *  Computed colors normalize HSL/alpha tokens to the RGB form xterm accepts. */
function themeFor(element: HTMLElement): ITheme {
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

const TerminalSurface: React.FC<TerminalSurfaceProps> = ({
  terminalRef,
  onReady,
  className = "",
  theme = "light",
  active = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalTerminalRef = useRef<any | null>(null);
  const targetRef = terminalRef ?? internalTerminalRef;
  const { resolvedTheme } = useTheme();
  const [readyTerminal, setReadyTerminal] = useState<Terminal | null>(null);
  useLogTerminal(readyTerminal, active);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    const initialize = async () => {
      if (!containerRef.current || targetRef.current) return;

      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");

      if (cancelled || !containerRef.current) return;

      const textStyle = getComputedStyle(containerRef.current);
      const terminal = new Terminal({
        fontFamily: textStyle.fontFamily,
        fontSize: parseFloat(textStyle.fontSize),
        lineHeight: 1.45,
        letterSpacing: 0,
        theme: themeFor(containerRef.current),
        cursorBlink: true,
        scrollback: 1000,
        convertEol: true,
      });
      const fitAddon = new FitAddon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(containerRef.current);
      targetRef.current = terminal;
      setReadyTerminal(terminal);

      const containerElement = containerRef.current;
      const fit = () => {
        // xterm's fit()/scrollToBottom() reach into the renderer, which has no
        // `dimensions` until the container is actually laid out. Calling them on
        // a 0-size or detached node (hidden panel, mid mount/unmount) leaves the
        // renderer half-initialized and throws "reading 'dimensions'" in a LATER
        // animation frame — outside this try/catch — which both crashes the
        // overlay and corrupts the terminal so the stream won't paint until a
        // refresh. Skip until it's visible and still mounted.
        if (targetRef.current !== terminal) return;
        if (!containerElement.isConnected) return;
        if (containerElement.offsetWidth === 0 || containerElement.offsetHeight === 0) return;
        try {
          fitAddon.fit();
          terminal.scrollToBottom();
        } catch (error) {
          console.error("Error fitting terminal:", error);
        }
      };

      const fitTimer = window.setTimeout(fit, 100);
      const resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(containerElement);
      window.addEventListener("resize", fit);

      onReady?.(terminal);

      cleanup = () => {
        window.clearTimeout(fitTimer);
        resizeObserver.disconnect();
        window.removeEventListener("resize", fit);
        terminal.dispose();
        if (targetRef.current === terminal) {
          targetRef.current = null;
        }
      };
    };

    void initialize();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const terminal = targetRef.current;
    if (!terminal || !containerRef.current) return;
    terminal.options.theme = themeFor(containerRef.current);
  }, [theme, resolvedTheme, targetRef]);

  return (
    <div
      dir="ltr"
      className={`terminal-container h-full w-full overflow-hidden bg-[var(--th-card-on-page)] p-4 font-mono text-sm antialiased sm:p-5 [&_.slider]:rounded-full ${className}`}
    >
      {/* FitAddon measures its parent; keep padding outside that measured area. */}
      <div ref={containerRef} className="h-full w-full min-w-0 overflow-hidden" />
    </div>
  );
};

export default TerminalSurface;
