// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceIcon } from "./ServiceIcon";

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
});

describe("service icon fallback", () => {
  it.each([
    { kind: "compose", build: "./api" },
    { kind: "monorepo", build: undefined },
  ] as const)("uses the service's role for $kind services built from source", (source) => {
    act(() => root.render(<ServiceIcon service={{ name: "api", ...source }} />));
    expect(host.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("server");
  });

  it.each([
    { exposed: false, icon: "window" },
    { exposed: true, icon: "globe" },
  ])("handles an unknown service role with exposed=$exposed", ({ exposed, icon }) => {
    act(() => root.render(<ServiceIcon service={{ name: "custom", build: ".", exposed }} />));
    expect(host.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(icon);
  });

  it("keeps a recognized image's brand logo", () => {
    act(() => root.render(<ServiceIcon service={{ name: "db", image: "postgres:16" }} />));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://cdn.simpleicons.org/postgresql");
    expect(host.querySelector("[data-icon]")).toBeNull();
  });

  it("uses the same role fallback when the brand logo cannot load", () => {
    act(() => root.render(<ServiceIcon service={{ name: "db", image: "postgres:16" }} className="size-4" />));
    act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")).toBeNull();
    const icon = host.querySelector("[data-icon]");
    expect(icon?.getAttribute("data-icon")).toBe("database");
    expect(icon?.getAttribute("class")).toContain("size-4");
  });
});
