// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ServiceSettingsForm } from "./ServiceSettingsForm";
import type { Service } from "@/lib/api/services";

const m = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ api: { post: m.post }, getApiRequestScopeVersion: () => 0 }));
vi.mock("@/lib/api", () => ({ getApiErrorMessage: (_: unknown, fallback: string) => fallback }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useOptionalProjectSettings: () => ({ id: "project" }),
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/components/project-settings/ReadinessSection", () => ({ default: () => null }));

let root: Root, host: HTMLDivElement;
const service = {
  id: "service",
  name: "web",
  kind: "monorepo",
  rootDirectory: "apps/web",
  framework: "nextjs",
  buildCommand: "TOKEN=secret npm run build",
} as Service;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.post.mockReset();
  m.post.mockResolvedValue({ data: { candidates: [], canMigrate: false } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps topology staging free of immediate backend migration actions", async () => {
  const submit = vi.fn();
  await act(async () =>
    root.render(
      <ServiceSettingsForm service={service} submitLabel="Stage changes" onSubmit={submit} />,
    ),
  );
  expect(host.textContent).toContain("TOKEN");
  expect(host.textContent).not.toContain("Move to Environment");
  expect(m.post).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ buildCommand: service.buildCommand }),
  );
  expect(m.post).not.toHaveBeenCalled();
});

it("exposes persisted migration actions when enabled by the saved service editor", async () => {
  await act(async () =>
    root.render(
      <ServiceSettingsForm
        service={service}
        includeVolumes={false}
        enableAutomationActions
        onSubmit={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain("Move to Environment");
  expect(m.post).toHaveBeenCalledExactlyOnceWith("projects/project/build-cache/migration", {
    serviceId: "service",
  });
});
