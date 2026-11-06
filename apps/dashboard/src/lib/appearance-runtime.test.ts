// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { APPEARANCE_DEFAULTS, APPEARANCE_TOKENS, defaultAppearance } from "@repo/core";
import { appearanceCacheKey, APPEARANCE_CACHE_POINTER, bootAppearance, cacheAppearance } from "./appearance-runtime";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.cookie = "openship-theme=;path=/;max-age=0";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

it("keeps the server's Dim theme when browser storage is unavailable", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("localStorage", {
    getItem() { throw new Error("blocked"); },
  });
  document.documentElement.dataset.theme = "dim";
  bootAppearance(APPEARANCE_DEFAULTS, APPEARANCE_TOKENS, { active: "dim", resolved: "dim" });
  expect(document.documentElement.dataset.theme).toBe("dim");
});

it("resolves a cookie's System preference from the current OS before paint", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  bootAppearance(APPEARANCE_DEFAULTS, APPEARANCE_TOKENS, { active: "system", resolved: "light" });
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("persists the small theme cookie even when localStorage writes fail", () => {
  vi.stubGlobal("localStorage", {
    setItem() { throw new Error("blocked"); },
  });
  cacheAppearance(appearanceCacheKey("https://instance.test:alice"), defaultAppearance("dim"), "dim");
  expect(document.cookie).toContain("openship-theme=dim:dim");
});
it("paints cached custom tokens before hydration and ignores unregistered or executable properties", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("CSS", { supports: () => true });
  const owner = appearanceCacheKey("https://instance.test:alice");
  localStorage.setItem(APPEARANCE_CACHE_POINTER, owner);
  localStorage.setItem(
    `${owner}:paint`,
    JSON.stringify({
      mode: "dim",
      active: "personal",
      variables: {
        "--th-bg-page": "#123456",
        "--appearance-font-size": "18px",
        "--th-card-bg": "url(https://tracker.test)",
        display: "none",
      },
    }),
  );
  bootAppearance(APPEARANCE_DEFAULTS, APPEARANCE_TOKENS, { active: "dim", resolved: "dim" });
  expect(document.documentElement.dataset.theme).toBe("dim");
  expect(document.documentElement.style.backgroundColor).toBe("#123456");
  expect(document.documentElement.style.fontSize).toBe("18px");
  expect(document.documentElement.style.getPropertyValue("--th-card-bg")).toBe("");
  expect(document.documentElement.style.display).toBe("");
});
it("resolves System from the current OS preference instead of yesterday's cached mode", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const owner = appearanceCacheKey("https://instance.test:alice");
  localStorage.setItem(APPEARANCE_CACHE_POINTER, owner);
  localStorage.setItem(
    `${owner}:paint`,
    JSON.stringify({ mode: "light", active: "system", variables: {} }),
  );
  bootAppearance(APPEARANCE_DEFAULTS, APPEARANCE_TOKENS);
  expect(document.documentElement.dataset.theme).toBe("dark");
});
