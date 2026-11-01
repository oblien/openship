import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ProjectSidebar } from "./ProjectSidebar";

const h = vi.hoisted(() => ({
  domains: [] as Array<{ domain: string; verified: boolean; primary: boolean; status: string }>,
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: {
      id: "project",
      name: "App",
      framework: "vite",
      latestDeploymentStatus: "ready",
      activeDeploymentId: "live",
    },
    projectNotFound: false,
    tabs: [],
    activeTabGroup: "domains",
    access: { host: null, url: null, isLocal: false, urls: [], kind: "none" },
    domainsData: { domains: h.domains },
  }),
}));
vi.mock("@/hooks/useProjectTabNavigation", () => ({ useProjectTabNavigation: () => () => {} }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
const render = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <ProjectSidebar />
    </I18nProvider>,
  );
beforeEach(() => {
  h.domains = [{ domain: "app.example.com", verified: false, primary: true, status: "pending" }];
});

it("shows an assigned pending domain instead of claiming that no domain exists", () => {
  const html = render();
  expect(html).toContain("app.example.com");
  expect(html).toContain("Pending");
  expect(html).not.toContain("Add domain");
  expect(html).not.toContain("No domain");
});

it("reflects successful verification even when the initial access URL has not refreshed", () => {
  h.domains[0]!.verified = true;
  h.domains[0]!.status = "active";
  expect(render()).toContain("app.example.com");
  expect(render()).not.toContain("Pending");
});

it("does not invent a visitable URL for a wildcard-only route", () => {
  h.domains[0]!.domain = "*.example.com";
  expect(render()).toContain("Add domain");
  expect(render()).not.toContain('href="https://*.example.com"');
});
