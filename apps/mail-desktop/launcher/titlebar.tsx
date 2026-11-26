import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopTitleBar } from "@repo/ui/desktop-titlebar";
import { Icon, IconProvider } from "@repo/ui/icons";
import { window as labels } from "../../dashboard/src/i18n/locales/en/chrome.json";

type WindowState = {
  canGoBack: boolean;
  canGoForward: boolean;
  maximized: boolean;
  background: string;
  dark: boolean;
};
type Action = "back" | "forward" | "minimize" | "maximize" | "close" | "menu";
declare global {
  interface Window {
    mailFrame: {
      mac: boolean;
      action(action: Action): void;
      onState(listener: (state: WindowState) => void): () => void;
    };
  }
}
const frame = window.mailFrame;
document.documentElement.classList.add("is-desktop");
document.documentElement.classList.toggle("is-desktop-mac", frame.mac);

function MailTitleBar() {
  const [state, setState] = useState<WindowState>({
    canGoBack: false,
    canGoForward: false,
    maximized: false,
    background: "#141414",
    dark: true,
  });
  useEffect(
    () =>
      frame.onState((next) => {
        document.documentElement.dataset.appearance = next.dark ? "dark" : "light";
        document.documentElement.style.setProperty("--th-bg-page", next.background);
        setState(next);
      }),
    [],
  );
  return (
    <IconProvider baseUrl="../dist/icons" fallbackBaseUrl="../dist/icons">
      <DesktopTitleBar
        {...state}
        labels={labels}
        mac={frame.mac}
        onBack={() => frame.action("back")}
        onForward={() => frame.action("forward")}
        onMinimize={() => frame.action("minimize")}
        onToggleMaximize={() => frame.action("maximize")}
        onClose={() => frame.action("close")}
        menu={
          <button
            type="button"
            className="app-titlebar-btn"
            aria-label="Application menu"
            title="Application menu"
            onClick={() => frame.action("menu")}
          >
            <Icon name="more" size={17} />
          </button>
        }
      />
    </IconProvider>
  );
}
createRoot(document.getElementById("titlebar")!).render(<MailTitleBar />);
