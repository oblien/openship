import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { DEFAULT_CONFIG, type DeploymentConfig } from "@/context/deployment/types";
import type EnvironmentVariables from "./EnvironmentVariables";
import ComposeServices from "./ComposeServices";

type EditorProps = ComponentProps<typeof EnvironmentVariables>;
const h = vi.hoisted(() => ({
  config: {} as DeploymentConfig,
  update: vi.fn(),
  editors: [] as EditorProps[],
  stored: vi.fn(), demoMode: false,
}));
vi.mock("@/context/DeploymentContext", () => ({
  useDeployment: () => ({ config: h.config, updateConfig: h.update }),
  useOptionalDeployment: () => undefined,
}));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "test.invalid" }) }));
vi.mock("@/lib/api/services", () => ({ servicesApi: { revealEnv: h.stored } }));
vi.mock("@/lib/demo-mode", () => ({ useDemoMode: () => h.demoMode }));
// Mount modal contents during server rendering; the real editor and the card's
// callback wiring run unchanged. Browser interaction is checked separately.
vi.mock("@/components/ui/Modal", () => ({ Modal: ({ children }: { children: ReactNode }) => children }));
vi.mock("./EnvironmentVariables", async importOriginal => {
  const { default: Editor } = await importOriginal<typeof import("./EnvironmentVariables")>();
  return { default: (props: EditorProps) => { h.editors.push(props); return <Editor {...props} />; } };
});

const MASK = "••••••••";
beforeEach(() => {
  vi.clearAllMocks();
  h.editors.length = 0;
  h.demoMode = false;
  h.config = {
    ...structuredClone(DEFAULT_CONFIG), projectName: "app", owner: "acme", repo: "app",
    projectType: "services", serviceDeploymentMode: "services",
    services: [
      { name: "db", image: "postgres:16", ports: [], dependsOn: [], volumes: [], environment: { POSTGRES_PASSWORD: "source-password" } },
      { name: "worker", image: "node:22", ports: [], dependsOn: [], volumes: [], environment: { API_TOKEN: "source-token" } },
    ],
  };
  h.stored.mockResolvedValue({ environment: { POSTGRES_PASSWORD: "stored-secret" } });
});

function render() {
  const html = renderToStaticMarkup(<I18nProvider><ComposeServices /></I18nProvider>);
  const editor = h.editors.find(props => props.envVars?.some(row => row.key === "POSTGRES_PASSWORD"));
  expect(editor).toBeDefined();
  return { html, editor: editor! };
}

describe("shared Compose environment editor", () => {
  it.each(["git", "local", "upload"])("shows %s scan values immediately without a reveal lookup", source => {
    if (source === "local") h.config.localPath = "/work/app";
    if (source === "upload") h.config.uploadSessionId = "upload-session";
    const { html, editor } = render();
    expect(html.match(/aria-label="Hide value"/g)).toHaveLength(2);
    expect(editor.envVars).toContainEqual({ key: "POSTGRES_PASSWORD", value: "source-password", visible: true });
    expect(editor.onReveal).toBeUndefined();
    expect(html).not.toContain("blur-[5px]");
    expect(h.stored).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("blurs every source value in demo mode without replacing or fetching values", () => {
    h.demoMode = true;
    const { html, editor } = render();
    expect(html.match(/blur-\[5px\] select-none/g)).toHaveLength(2);
    expect(editor.envVars?.[0]?.value).toBe("source-password");
    expect(h.config.services[0]!.environment.POSTGRES_PASSWORD).toBe("source-password");
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stored).not.toHaveBeenCalled();
  });

  it("reveals a saved row with the shared service lookup and preserves its stored-value sentinel", async () => {
    h.config.projectId = "project-id";
    h.config.services[0]!.serviceId = "service-id";
    h.config.services[0]!.environment.POSTGRES_PASSWORD = MASK;
    const { editor } = render();
    expect(h.stored).not.toHaveBeenCalled();
    expect(await editor.onReveal!(["POSTGRES_PASSWORD"])).toEqual({ POSTGRES_PASSWORD: "stored-secret" });
    expect(h.stored).toHaveBeenCalledExactlyOnceWith("project-id", "service-id", ["POSTGRES_PASSWORD"], undefined);
    expect(h.config.services[0]!.environment.POSTGRES_PASSWORD).toBe(MASK);
    expect(h.update).not.toHaveBeenCalled();
  });
});
