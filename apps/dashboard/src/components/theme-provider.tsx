"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function resolveTheme(t: Theme): ResolvedTheme {
  if (t === "light" || t === "dark") return t;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolved] = useState<ResolvedTheme>("dark");

  // Initialize from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const t: Theme = stored === "light" || stored === "dark" ? stored : "system";
    const resolved = resolveTheme(t);
    setThemeState(t);
    setResolved(resolved);
    applyTheme(resolved);
  }, []);

  // Listen for OS preference changes when in system mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange() {
      const r = resolveTheme("system");
      setResolved(r);
      applyTheme(r);
    }
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    const resolved = resolveTheme(t);
    setThemeState(t);
    setResolved(resolved);
    localStorage.setItem("theme", t);
    applyTheme(resolved);
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** Inline script injected in <head> to set data-theme before hydration — prevents flash */
export function ThemeScript() {
  const script = `
    (function(){
      var t = localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') {
        document.documentElement.setAttribute('data-theme', t);
      } else {
        document.documentElement.setAttribute('data-theme',
          window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      }
    })();
  `;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
