// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROXY_DIRECTIVES, type RoutingConfig } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { RoutingConfigEditor } from "./RoutingConfigEditor";
import copy from "@/i18n/locales/en/widgets.json";

let root: Root;
let container: HTMLDivElement;
let latest: RoutingConfig | null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(
  initial: RoutingConfig | null = null,
  showProxySettings = true,
  disabled = false,
) {
  latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <I18nProvider>
        <RoutingConfigEditor
          value={value}
          onChange={(next) => {
            latest = next;
            setValue(next);
          }}
          showProxySettings={showProxySettings}
          disabled={disabled}
        />
      </I18nProvider>
    );
  }
  await act(async () => root.render(<Harness />));
}
function button(label: string, scope: ParentNode = container) {
  const element = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(element, label).toBeDefined();
  return element!;
}
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
}
function input(label: string, scope: ParentNode = container) {
  const element = Array.from(scope.querySelectorAll("label")).find(
    (l) => l.textContent?.trim() === label,
  );
  expect(element, label).toBeDefined();
  return (
    element!.htmlFor ? document.getElementById(element!.htmlFor) : element!.querySelector("input")
  ) as HTMLInputElement;
}
async function fill(label: string, value: string, scope?: ParentNode) {
  const element = input(label, scope);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(label: string, option: string) {
  await click(label);
  const element = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (e) => e.textContent?.trim() === option,
  );
  expect(element, option).toBeDefined();
  await act(async () => element!.click());
}

it("adds, edits and removes rewrites without losing hidden proxy settings", async () => {
  await render({ proxy: { gzip: false } }, false);
  await click("Add Rewrites");
  await fill("Matching path", "/api/(.*)");
  await fill("Destination", "https://backend/$1");
  expect(latest).toEqual({
    rewrites: [{ source: "/api/(.*)", destination: "https://backend/$1" }],
    proxy: { gzip: false },
  });
  await click("Remove");
  expect(latest).toEqual({ proxy: { gzip: false } });
});

it("adds, edits, toggles and removes redirects", async () => {
  await render();
  await click("Add Redirects");
  await fill("Matching path", "/old");
  await fill("Destination", "/new");
  expect(button("Permanent redirect").getAttribute("aria-checked")).toBe("false");
  await click("Permanent redirect");
  expect(latest).toEqual({ redirects: [{ source: "/old", destination: "/new", permanent: true }] });
  await click("Remove");
  expect(latest).toBeNull();
});

it("preserves imported redirects' default permanent behavior", async () => {
  await render({ redirects: [{ source: "/old", destination: "/new" }] });
  expect(button("Permanent redirect").getAttribute("aria-checked")).toBe("true");
  await click("Permanent redirect");
  expect(latest?.redirects?.[0]?.permanent).toBe(false);
});

it("edits header rules and adds and removes individual headers and whole rules", async () => {
  await render();
  await click("Add Response headers");
  await fill("Matching path", "/assets/(.*)");
  await fill("Header name", "Cache-Control");
  await fill("Header value", "public, max-age=3600");
  await click("Add header");
  expect(latest?.headers).toEqual([
    {
      source: "/assets/(.*)",
      headers: [
        { key: "Cache-Control", value: "public, max-age=3600" },
        { key: "", value: "" },
      ],
    },
  ]);
  await click("Remove header");
  expect(latest?.headers?.[0]?.headers).toEqual([{ key: "", value: "" }]);
  await click("Remove");
  expect(latest).toBeNull();
});

it("toggles URL options without losing an explicit false proxy setting", async () => {
  await render({ proxy: { proxyBuffering: false } });
  await click("Hide .html extensions");
  await select("Trailing slash", "Add");
  expect(latest).toEqual({
    cleanUrls: true,
    trailingSlash: true,
    proxy: { proxyBuffering: false },
  });
  await click("Hide .html extensions");
  await select("Trailing slash", "Automatic");
  expect(latest).toEqual({ proxy: { proxyBuffering: false } });
});

it("offers every directive with a human label outside optional technical details", async () => {
  await render();
  const labels: Record<string, string> = copy.routing.configEditor.proxyLabels;
  for (const spec of PROXY_DIRECTIVES) {
    expect(labels[spec.key]).toBeTruthy();
    const control = spec.kind === "bool" ? button(labels[spec.key]!) : input(labels[spec.key]!);
    expect(control.closest("details")).toBeNull();
  }
  expect(container.querySelectorAll("details")).toHaveLength(6);
  expect(container.querySelectorAll("details[open]")).toHaveLength(0);
});

it("retains all three proxy boolean states and clears to inherited defaults", async () => {
  await render();
  expect(button("Compress responses").textContent).toContain("Use server default");
  await select("Compress responses", "Enabled");
  expect(latest).toEqual({ proxy: { gzip: true } });
  await select("Compress responses", "Disabled");
  expect(latest).toEqual({ proxy: { gzip: false } });
  await select("Compress responses", "Use server default");
  expect(latest).toBeNull();
});

it("keeps size/time/buffer payload strings and numeric settings, and clears keys", async () => {
  await render();
  await fill("Upload size limit", "25m");
  await fill("Read timeout", "300s");
  await fill("Response buffers", "8 16k");
  await fill("Compression level", "4");
  expect(latest).toEqual({
    proxy: {
      clientMaxBodySize: "25m",
      proxyReadTimeout: "300s",
      proxyBuffers: "8 16k",
      gzipCompLevel: 4,
    },
  });
  for (const label of [
    "Upload size limit",
    "Read timeout",
    "Response buffers",
    "Compression level",
  ])
    await fill(label, "");
  expect(latest).toBeNull();
});

it("disables editing controls during save", async () => {
  await render({ rewrites: [{ source: "/", destination: "/index.html" }] }, true, true);
  for (const control of container.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    "input,button",
  ))
    expect(control.disabled).toBe(true);
  await click("Add Rewrites");
  expect(latest).toEqual({ rewrites: [{ source: "/", destination: "/index.html" }] });
});

it.each([undefined, true, false])(
  "preserves imported trailingSlash=%s when editing another option",
  async (trailingSlash) => {
    await render(trailingSlash === undefined ? null : { trailingSlash });
    expect(button("Trailing slash").textContent).toContain(
      trailingSlash === undefined ? "Automatic" : trailingSlash ? "Add" : "Remove",
    );
    await click("Hide .html extensions");
    expect(latest).toEqual(
      trailingSlash === undefined ? { cleanUrls: true } : { cleanUrls: true, trailingSlash },
    );
  },
);

it("sets and clears each trailing slash policy without losing other settings", async () => {
  await render({ proxy: { gzip: false } });
  await select("Trailing slash", "Remove");
  expect(latest).toEqual({ proxy: { gzip: false }, trailingSlash: false });
  await select("Trailing slash", "Add");
  expect(latest).toEqual({ proxy: { gzip: false }, trailingSlash: true });
  await select("Trailing slash", "Automatic");
  expect(latest).toEqual({ proxy: { gzip: false } });
});
