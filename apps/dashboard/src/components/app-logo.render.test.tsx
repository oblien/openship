// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLogo, refreshCustomAppLogos } from "./AppLogo";

const catalog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/apps", () => ({ appsApi: { catalog } }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("shared app logo", () => {
  it("uses a fallback for an image that already failed before hydration", async () => {
    // A completed but undecodable image represents a missed pre-hydration error.
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(
      new Error("Image unavailable"),
    );
    await act(async () => root.render(<AppLogo slug="convex" fallback={<span>App</span>} />));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("App");
  });

  it("loads a newly selected logo after another URL failed", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    await act(async () => root.render(<AppLogo slug="postgresql" />));
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")).toBeNull();
    await act(async () => root.render(<AppLogo slug="supabase" />));
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.simpleicons.org/supabase",
    );
  });

  it.each([
    ["an https URL", "https://example.com/logo.png"],
    ["an image data URI", "data:image/svg+xml;base64,PHN2Zy8+"],
  ])("renders a custom logo given as %s (#1507)", async (_label, logo) => {
    await act(async () => root.render(<AppLogo slug={logo} />));
    expect(host.querySelector("img")?.getAttribute("src")).toBe(logo);
  });

  it.each(["javascript:alert(1)", "http://example.com/logo.png", "a/b"])(
    "shows the fallback instead of requesting %s",
    async (logo) => {
      await act(async () => root.render(<AppLogo slug={logo} fallback={<span>App</span>} />));
      expect(host.querySelector("img")).toBeNull();
      expect(host.textContent).toBe("App");
    },
  );

  it("shows a custom app's own logo where only its app id is known (#1507)", async () => {
    refreshCustomAppLogos();
    catalog.mockResolvedValue({
      data: [{ id: "my-tool", custom: true, logo: "https://example.com/my-tool.png" }],
    });
    await act(async () => root.render(<AppLogo appId="my-tool" />));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://example.com/my-tool.png");
    expect(catalog).toHaveBeenCalledTimes(1);
  });
});
