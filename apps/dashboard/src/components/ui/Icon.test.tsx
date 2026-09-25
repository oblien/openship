// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Icon, IconArtwork, IconProvider, iconAssetUrl, outlineModern, type IconTheme } from "@repo/ui/icons";

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

function render(element: React.ReactNode) {
  act(() => {
    root ??= createRoot(host);
    root.render(element);
  });
}

function imageSource() {
  return host.querySelector("image")?.getAttribute("href");
}

function failImage() {
  act(() => { host.querySelector("image")!.dispatchEvent(new Event("error")); });
}

describe("shared icon rendering", () => {
  it("uses bundled artwork and inherits the control's color through an alpha mask", () => {
    render(<Icon name="server" className="size-4 text-primary" />);
    const svg = host.querySelector("svg")!;
    expect(imageSource()).toBe(iconAssetUrl(outlineModern.server));
    expect(svg.getAttribute("data-icon")).toBe("server");
    expect(svg.getAttribute("class")).toBe("size-4 text-primary");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
    expect(host.querySelector("mask")?.getAttribute("style")).toContain("mask-type: alpha");
    expect(host.querySelector("rect")?.getAttribute("fill")).toBe("currentColor");
  });

  it("preserves colorful artwork", () => {
    render(<Icon name="google" className="text-danger" />);
    expect(imageSource()).toBe(iconAssetUrl(outlineModern.google));
    expect(host.querySelector("mask")).toBeNull();
    expect(host.querySelector("rect")).toBeNull();
  });

  it.each([
    { inset: undefined, imageSize: "44", imageOffset: "-10" },
    { inset: 3, imageSize: "36", imageOffset: "-6" },
  ])("centers the visible artwork with inset $inset without enlarging the layout box", ({ inset, imageSize, imageOffset }) => {
    const theme: IconTheme = {
      name: "padded",
      icons: { server: { file: "padded.png", mode: "mask", bounds: [6, 9, 12, 6], inset } },
    };
    render(<IconProvider theme={theme}><Icon name="server" size={18} /></IconProvider>);
    const svg = host.querySelector("svg")!;
    const image = host.querySelector("image")!;
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("height")).toBe("18");
    // Source padding is removed; the asset's inset controls only its visible size.
    expect(image.getAttribute("width")).toBe(imageSize);
    expect(image.getAttribute("height")).toBe(imageSize);
    expect(image.getAttribute("x")).toBe(imageOffset);
    expect(image.getAttribute("y")).toBe(imageOffset);
  });

  it("forwards dimensions, refs, presentation props, and events to the SVG viewport", () => {
    const ref = createRef<SVGSVGElement>();
    const click = vi.fn();
    render(<Icon name="check" ref={ref} size={16} width={20} x={12} y={8} style={{ opacity: 0.5 }} onClick={click} />);
    const svg = host.querySelector("svg")!;
    expect(ref.current).toBe(svg);
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("x")).toBe("12");
    expect(svg.getAttribute("y")).toBe("8");
    expect(svg.getAttribute("style")).toContain("opacity: 0.5");
    act(() => { svg.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(click).toHaveBeenCalledOnce();
  });

  it("is decorative by default and supports a title or an explicit accessible name", () => {
    render(<><Icon name="cloud" /><Icon name="cloud" title="Deployment server" /><Icon name="cloud" aria-label="Cloud connected" /></>);
    const [decorative, titled, labelled] = host.querySelectorAll("svg");
    expect(decorative.getAttribute("aria-hidden")).toBe("true");
    expect(titled.getAttribute("role")).toBe("img");
    expect(titled.hasAttribute("aria-hidden")).toBe(false);
    expect(titled.getAttribute("aria-labelledby")).toBe(titled.querySelector("title")?.id);
    expect(titled.querySelector("title")?.textContent).toBe("Deployment server");
    expect(labelled.getAttribute("aria-label")).toBe("Cloud connected");
    expect(labelled.hasAttribute("aria-hidden")).toBe(false);
  });

  it("preserves an external accessible label instead of replacing it with its title", () => {
    render(<><span id="icon-description">Project</span><Icon name="project" title="Project icon" aria-labelledby="icon-description" /></>);
    expect(host.querySelector("svg")?.getAttribute("aria-labelledby")).toBe("icon-description");
  });

  it("gives repeated icons independent mask IDs that remain stable through hydration", async () => {
    const elements = <><Icon name="server" title="First server" /><Icon name="server" title="Second server" /></>;
    host.innerHTML = renderToString(elements);
    const ids = Array.from(host.querySelectorAll("mask"), (mask) => mask.id);
    expect(new Set(ids).size).toBe(2);
    expect(Array.from(host.querySelectorAll("rect"), (rect) => rect.getAttribute("mask"))).toEqual(ids.map((id) => `url(#${id})`));
    const recoverableError = vi.fn();
    await act(async () => { root = hydrateRoot(host, elements, { onRecoverableError: recoverableError }); });
    expect(Array.from(host.querySelectorAll("mask"), (mask) => mask.id)).toEqual(ids);
    expect(recoverableError).not.toHaveBeenCalled();
  });

  it("supports PNG icons inside SVG diagrams", () => {
    render(<svg viewBox="0 0 100 100"><Icon name="server" x={40} y={30} size={20} /></svg>);
    const icon = host.querySelector('[data-icon="server"]')!;
    expect(icon.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(icon.querySelector("image")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(icon.getAttribute("x")).toBe("40");
  });
});

describe("icon configuration and recovery", () => {
  const theme: IconTheme = { name: "custom", icons: { server: { file: "custom server.png", mode: "color" } } };

  it("inherits the parent asset host while overriding only the selected artwork", () => {
    render(<IconProvider baseUrl="https://icons.example.test/artwork/"><IconProvider theme={theme}><Icon name="server" /><Icon name="search" /></IconProvider></IconProvider>);
    const icons = host.querySelectorAll("svg");
    expect(icons[0].querySelector("image")?.getAttribute("href")).toBe("https://icons.example.test/artwork/custom%20server.png");
    expect(icons[0].querySelector("mask")).toBeNull();
    expect(icons[1].querySelector("image")?.getAttribute("href")).toBe(iconAssetUrl(outlineModern.search, "https://icons.example.test/artwork"));
    expect(icons[1].querySelector("mask")).not.toBeNull();
  });

  it("falls back from a failed CDN/theme asset to the bundled default without a retry loop", () => {
    render(<IconProvider baseUrl="https://icons.example.test" theme={theme}><Icon name="server" /></IconProvider>);
    expect(host.querySelector("mask")).toBeNull();
    failImage();
    expect(imageSource()).toBe(iconAssetUrl(outlineModern.server));
    expect(host.querySelector("mask")).not.toBeNull();
    failImage();
    expect(imageSource()).toBe(iconAssetUrl(outlineModern.server));
    expect(host.querySelectorAll("image")).toHaveLength(1);
  });

  it("tries the new asset host after a source change, including after a previous failure", () => {
    render(<IconProvider baseUrl="https://broken.example.test"><Icon name="server" /></IconProvider>);
    failImage();
    render(<IconProvider baseUrl="https://working.example.test"><Icon name="server" /></IconProvider>);
    expect(imageSource()).toBe(iconAssetUrl(outlineModern.server, "https://working.example.test"));
  });

  it("keeps artwork sizing consistent on the CDN and restores bundled bounds and inset on fallback", () => {
    const imageGeometry = () => {
      const image = host.querySelector("image")!;
      return ["x", "y", "width", "height"].map((key) => image.getAttribute(key));
    };
    render(<Icon name="arrow-up-right" />);
    const localGeometry = imageGeometry();
    render(<IconProvider baseUrl="https://icons.example.test"><Icon name="arrow-up-right" /></IconProvider>);
    expect(imageGeometry()).toEqual(localGeometry);
    const padded: IconTheme = {
      name: "padded",
      icons: { "arrow-up-right": { file: "padded.png", mode: "mask", bounds: [6, 9, 12, 6], inset: 2 } },
    };
    render(<IconProvider theme={padded}><Icon name="arrow-up-right" /></IconProvider>);
    expect(imageGeometry()).not.toEqual(localGeometry);
    failImage();
    expect(imageGeometry()).toEqual(localGeometry);
  });

  it("recovers when a missing theme asset is replaced, and when the icon ID changes", () => {
    render(<IconProvider theme={theme}><Icon name="server" /></IconProvider>);
    failImage();
    const replacement: IconTheme = { name: "replacement", icons: { server: { file: "new.png", mode: "color" } } };
    render(<IconProvider theme={replacement}><Icon name="server" /></IconProvider>);
    expect(imageSource()).toBe("/icons/new.png");
    expect(host.querySelector("mask")).toBeNull();
    render(<IconProvider theme={replacement}><Icon name="mail" /></IconProvider>);
    expect(imageSource()).toBe(iconAssetUrl(outlineModern.mail));
  });

  it("uses the same renderer for user artwork previews without treating the URL as an icon ID", () => {
    render(<IconArtwork src="https://artwork.example.test/user.png" mode="mask" size={40} />);
    expect(imageSource()).toBe("https://artwork.example.test/user.png");
    expect(host.querySelector("svg")?.hasAttribute("data-icon")).toBe(false);
    expect(host.querySelector("svg")?.getAttribute("width")).toBe("40");
  });
});
