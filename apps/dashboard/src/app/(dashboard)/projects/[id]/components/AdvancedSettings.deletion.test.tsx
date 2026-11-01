import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { AdvancedSettings } from "./AdvancedSettings";

const h = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ projectData: h.project, servicesData: { services: [] } }),
}));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: false }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (value: string) => value,
}));
vi.mock("./BuildSettings", () => ({ BuildSettings: () => null }));
vi.mock("@/components/rollback/ProjectRollbackSettings", () => ({
  ProjectRollbackSettings: () => null,
}));
vi.mock("@/components/project-settings/CloudStaticHosting", () => ({
  CloudStaticHosting: () => null,
}));

beforeEach(() => {
  h.project = { id: "project", name: "App", deployTarget: "cloud", activeDeploymentId: "release" };
});
const deleteButton = () => {
  const html = renderToStaticMarkup(<AdvancedSettings onDeleteProject={() => {}} />);
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return buttons.find(
    (button) => button.includes("Delete Project") || button.includes("Deleting"),
  )!;
};

it("shows loading and disables deletion while the project's deletion operation is running", () => {
  h.project.deletionInProgress = true;
  h.project.lifecycleOperation = { kind: "delete", status: "running" };
  const button = deleteButton();
  expect(button).toContain("Deleting");
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain('disabled=""');
  expect(button).toContain("animate-spin");
});

it("allows retrying failed cleanup instead of leaving a permanent loading button", () => {
  h.project.deletionInProgress = true;
  h.project.lifecycleOperation = { kind: "delete", status: "failed", error: "cleanup failed" };
  const button = deleteButton();
  expect(button).toContain("Delete Project");
  expect(button).not.toContain('disabled=""');
  expect(button).not.toContain('aria-busy="true"');
});
