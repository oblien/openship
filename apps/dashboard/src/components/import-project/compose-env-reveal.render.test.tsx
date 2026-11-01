import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { DEFAULT_CONFIG, type DeploymentConfig } from "@/context/deployment/types";
import type EnvironmentVariables from "./EnvironmentVariables";
import ComposeServices from "./ComposeServices";
import { baseDictionary } from "@/i18n";

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
  h.editors.length = 0;
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ComposeServices />
    </I18nProvider>,
  );
  const editor = h.editors.find((props) =>
    props.envVars?.some((row) => row.key === "POSTGRES_PASSWORD"),
  );
  expect(editor).toBeDefined();
  return { html, editor: editor! };
}

describe("shared Compose environment editor", () => {
  it("shows a saved Compose default as an editable value and keeps its expression when another row changes", () => {
    h.config.projectId = "project-id";
    const service = h.config.services[0]!;
    service.environment = {
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-source-password}",
      NODE_ENV: "production",
    };
    service.advanced = { environmentTemplateKeys: ["POSTGRES_PASSWORD"] };
    const { editor, html } = render();
    expect(editor.envVars).toContainEqual({
      key: "POSTGRES_PASSWORD",
      value: "source-password",
      visible: true,
    });
    expect(html).not.toContain("${POSTGRES_PASSWORD");
    expect(h.update).not.toHaveBeenCalled();
    editor.onEnvVarsChange!([
      { key: "POSTGRES_PASSWORD", value: "source-password", visible: false },
      { key: "NODE_ENV", value: "test", visible: true },
    ]);
    expect(h.update).toHaveBeenCalledWith({
      services: [
        expect.objectContaining({
          environment: {
            POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-source-password}",
            NODE_ENV: "test",
          },
          advanced: { environmentTemplateKeys: ["POSTGRES_PASSWORD"] },
        }),
        h.config.services[1],
      ],
    });
    expect(h.stored).not.toHaveBeenCalled();
  });

  it.each(["", "https://api.example.com/?token="])(
    "clears missing badges after filling an unresolved preview (%s) and restores them when emptied",
    (preview) => {
      const service = h.config.services[0]!;
      service.environment.POSTGRES_PASSWORD = preview;
      service.environmentMeta = {
        POSTGRES_PASSWORD: {
          source: preview ? "interpolated" : "missing",
          required: true,
          resolvedValue: preview,
          expression: "${CREDENTIAL:?required}",
        },
      };
      h.update.mockImplementation((patch) => {
        h.config = { ...h.config, ...patch };
      });
      const label = baseDictionary.importProject.environmentVariables.resolution.needsValue;
      const initial = render();
      expect(initial.html).toContain(label);
      expect(initial.html).toContain("1 missing");
      initial.editor.onEnvVarsChange!([
        { key: "POSTGRES_PASSWORD", value: "entered-value", visible: true },
      ]);

      const filled = render();
      expect(filled.html).not.toContain(label);
      expect(filled.html).not.toContain("1 missing");
      expect(h.config.services[0]!.environment.POSTGRES_PASSWORD).toBe("entered-value");

      filled.editor.onEnvVarsChange!([{ key: "POSTGRES_PASSWORD", value: "", visible: true }]);
      expect(render().html).toContain(label);
    },
  );

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
    const rows = [
      {
        key: "POSTGRES_PASSWORD",
        value: MASK,
        visible: false,
        isSecret: true,
        keyReadOnly: true,
        removalDisabled: true,
      },
    ];
    h.config.services[0]!.environmentDraft = { environment: "production", baseline: rows, rows };
    const { editor } = render();
    expect(h.stored).not.toHaveBeenCalled();
    expect(await editor.onReveal!(["POSTGRES_PASSWORD"])).toEqual({
      POSTGRES_PASSWORD: "stored-secret",
    });
    expect(h.stored).toHaveBeenCalledExactlyOnceWith(
      "project-id",
      "service-id",
      ["POSTGRES_PASSWORD"],
      "production",
    );
    expect(h.config.services[0]!.environment.POSTGRES_PASSWORD).toBe(MASK);
    expect(h.update).not.toHaveBeenCalled();
  });
});
