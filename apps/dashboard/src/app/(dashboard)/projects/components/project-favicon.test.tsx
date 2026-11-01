// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import type { Project } from "@/constants/mock";
import ProjectCard from "./ProjectCard";
import ProjectGridCard from "./ProjectGridCard";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let root: Root | undefined;
let container: HTMLDivElement;
let complete: boolean;
let naturalWidth: number;
const project = {
  id: "project", name: "App", slug: "app", framework: "docker",
  createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
} as Project;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  complete = true;
  naturalWidth = 0;
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockImplementation(() => complete);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(() => naturalWidth);
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const [name, Card] of [["list", ProjectCard], ["grid", ProjectGridCard]] as const) {
  const render = (favicon = "/favicon-old.ico") => (
    <I18nProvider><ModalProvider><Card project={{ ...project, favicon }} /></ModalProvider></I18nProvider>
  );
  describe(`${name} favicon`, () => {
    it("falls back when the image failed before hydration attached its error listener", async () => {
      const view = render();
      container.innerHTML = renderToString(view);
      expect(container.querySelector('img[alt=""]')).not.toBeNull();
      // The browser already finished the failed image. No new error event
      // will arrive when React hydrates this server-rendered row.
      await act(async () => { root = hydrateRoot(container, view); });
      expect(container.querySelector('img[alt=""]')).toBeNull();
    });

    it("tries a changed URL after a previous image failed", async () => {
      complete = false;
      root = createRoot(container);
      await act(async () => root!.render(render()));
      await act(async () => container.querySelector('img[alt=""]')!.dispatchEvent(new Event("error")));
      expect(container.querySelector('img[alt=""]')).toBeNull();
      await act(async () => root!.render(render("/favicon-new.ico")));
      expect(container.querySelector('img[alt=""]')?.getAttribute("src")).toBe("/favicon-new.ico");
    });

    it("keeps a successfully cached favicon", async () => {
      naturalWidth = 32;
      const view = render();
      container.innerHTML = renderToString(view);
      await act(async () => { root = hydrateRoot(container, view); });
      expect(container.querySelector('img[alt=""]')?.getAttribute("src")).toBe("/favicon-old.ico");
    });
  });
}


it("opens the grid More menu independently and navigates to the selected project screen", async () => {
  push.mockClear();
  root = createRoot(container);
  await act(async () => root!.render(
    <I18nProvider><ProjectGridCard project={project} /></I18nProvider>,
  ));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="App: More"]')!;
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(push).not.toHaveBeenCalled();
  const domains = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Domains & Routes"))!;
  await act(async () => domains.click());
  expect(push).toHaveBeenCalledWith("/projects/project/domains");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
