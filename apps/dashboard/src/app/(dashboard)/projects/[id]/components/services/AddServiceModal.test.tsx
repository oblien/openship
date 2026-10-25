// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { AddServiceModal } from "./AddServiceModal";
import { getAppTemplate } from "@repo/core";
import { setApiResourceScope } from "@/lib/api/client";
import type { ServiceRepositorySource } from "./repository-source";
import type { RoutingSettingsCardProps } from "@/components/routing/RoutingSettingsCard";

const h = vi.hoisted(() => ({
  mode: "cloud",
  submit: vi.fn(),
  close: vi.fn(),
  tree: vi.fn(),
  connected: true,
}));
vi.mock("@/lib/api/github", () => ({ githubApi: { getRepoTree: h.tree } }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ deployMode: h.mode }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: h.connected }) }));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? children : null,
}));
vi.mock("../UseInProjectModal", () => ({ ProjectConnectionForm: () => null }));
vi.mock("@/components/routing/RoutingSettingsCard", () => ({
  RoutingSettingsCard: (props: RoutingSettingsCardProps) => (
    <button
      type="button"
      onClick={() => {
        props.onExposedChange?.(true);
        props.onExposedPortChange?.("9001");
        props.onDomainTypeChange("custom");
        props.onCustomDomainChange("storage.example.test");
        props.onDomainChange("storage");
      }}
    >
      Configure public route
    </button>
  ),
}));

let host: HTMLDivElement;
let root: Root;
const copy = baseDictionary.projectDetail.services.addModal;
const envCopy = baseDictionary.projectSettings.envVars;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.mode = "cloud";
  h.connected = true;
  h.tree.mockResolvedValue({
    data: [
      { path: "apps/api/Dockerfile.prod", type: "file" },
      { path: "apps/api/package.json", type: "file" },
    ],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (linkedCloud = false, open = true, repository?: ServiceRepositorySource | null) =>
  act(async () =>
    root.render(
      <I18nProvider>
        <AddServiceModal
          repository={repository}
          open={open}
          projectName="Example"
          isCloudProject={linkedCloud}
          onClose={h.close}
          onSubmit={h.submit}
        />
      </I18nProvider>,
    ),
  );
async function pick(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.includes(text),
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
const submit = () =>
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const edit = (placeholder: string, value: string) =>
  typeInto(host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!, value);
/** The rendered env editor row whose key field holds `key`. */
function envRow(key: string) {
  const row = [...host.querySelectorAll<HTMLElement>("[data-env-index]")].find(
    (node) => node.querySelector<HTMLInputElement>('input[placeholder="KEY"]')?.value === key,
  );
  expect(row, key).toBeDefined();
  return {
    value: row!.querySelector<HTMLInputElement>('input:not([placeholder="KEY"])')!,
    reveal: row!.querySelector<HTMLButtonElement>(`button[aria-label="${envCopy.showValue}"]`),
  };
}
const sentEnv = (call: number): Record<string, string> => h.submit.mock.calls[call]![0].environment;
// Same shape as MinIO's generated root password: 24 random bytes as hex.
const GENERATED = /^[a-f0-9]{48}$/;
it.each(["cloud", "local", "linked"])(
  "adds Redis with its persistent volume through the same form (%s)",
  async (mode) => {
    h.mode = mode === "cloud" ? "cloud" : "local";
    await render(mode === "linked");
    await pick("redis:7-alpine");
    await act(async () => {
      submit();
    });
    expect(h.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ image: "redis:7-alpine", volumes: ["redis_data:/data"] }),
    );
    expect(h.close).toHaveBeenCalledOnce();
  },
);
it.each(["cloud", "local", "linked"])(
  "keeps MinIO's entrypoint argv and generates credentials (%s)",
  async (mode) => {
    h.mode = mode === "cloud" ? "cloud" : "local";
    const minio = getAppTemplate("minio")!.services![0]!;
    await render(mode === "linked");
    await pick(minio.image!);
    await act(async () => {
      submit();
    });
    expect(h.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        image: minio.image,
        command: "",
        commandArgv: ["server", "/data", "--console-address", ":9001"],
        volumes: ["minio_data:/data"],
        environment: expect.objectContaining({
          MINIO_ROOT_PASSWORD: expect.stringMatching(/^[a-f0-9]{48}$/),
        }),
      }),
    );
  },
);
it.each(["cloud", "local", "linked"])(
  "starts CockroachDB securely with persistent data and certificates (%s)",
  async (mode) => {
    h.mode = mode === "cloud" ? "cloud" : "local";
    await render(mode === "linked");
    await pick("cockroachdb/cockroach:latest");
    await act(async () => {
      submit();
    });
    expect(h.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        image: "cockroachdb/cockroach:latest",
        command: "",
        commandArgv: ["start-single-node", "--certs-dir=/cockroach/certs"],
        volumes: [
          "cockroach_data:/cockroach/cockroach-data",
          "cockroach_certs:/cockroach/certs",
        ],
        environment: {
          COCKROACH_DATABASE: "app",
          COCKROACH_USER: "app",
          COCKROACH_PASSWORD: expect.stringMatching(GENERATED),
        },
        exposed: false,
      }),
    );
  },
);
it("sends the GPU request of Ollama (NVIDIA GPU)", async () => {
  h.mode = "local";
  const name = "Ollama (NVIDIA GPU)";
  await render();
  await pick(name);
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      advanced: { gpus: { driver: "nvidia", count: 1, capabilities: ["gpu"] } },
    }),
  );
});
it("sends no GPU request for plain Ollama or a replacement image", async () => {
  h.mode = "local";
  await render();
  await pick(getAppTemplate("ollama")!.services![0]!.image!);
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[0]![0]).not.toHaveProperty("advanced");
});
it("does not carry a catalog GPU request onto a user-selected replacement image", async () => {
  h.mode = "local";
  await render();
  await pick("Ollama (NVIDIA GPU)");
  await edit("postgres:16-alpine", "example/other:v1");
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[0]![0]).not.toHaveProperty("advanced");
});
it("does not apply catalog argv to a user-selected replacement image", async () => {
  await render();
  await pick(getAppTemplate("minio")!.services![0]!.image!);
  await edit("postgres:16-alpine", "example/custom-storage:v1");
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[0]![0]).not.toHaveProperty("commandArgv");
});
it("validates a custom service name and image before submitting", async () => {
  await render();
  await pick(copy.customImage);
  await act(async () => {
    submit();
  });
  expect(host.textContent).toContain(copy.serviceNameRequired);
  await edit("postgres", "my-api");
  await act(async () => {
    submit();
  });
  expect(host.textContent).toContain(copy.imageRequired);
  expect(h.submit).not.toHaveBeenCalled();
  await edit("postgres:16-alpine", "registry.example.test/api:v2");
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "my-api", image: "registry.example.test/api:v2" }),
  );
});
it("retains configuration after a failed save and permits retry", async () => {
  h.submit.mockRejectedValueOnce(new Error("Server unavailable"));
  await render();
  await pick("redis:7");
  await act(async () => {
    submit();
  });
  expect(host.textContent).toContain("Server unavailable");
  expect(h.close).not.toHaveBeenCalled();
  const first = h.submit.mock.calls[0]![0];
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[1]![0]).toEqual(first);
  expect(h.close).toHaveBeenCalledOnce();
});
it("prevents duplicate service creation while a save is pending", async () => {
  let resolve!: () => void;
  h.submit.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  await render();
  await pick("redis:7-alpine");
  await act(async () => {
    submit();
    submit();
  });
  expect(h.submit).toHaveBeenCalledOnce();
  expect(h.close).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(h.close).toHaveBeenCalledOnce();
});

it.each(["cloud", "linked"])(
  "does not offer either self-hosted Ollama mode on managed Cloud (%s)",
  async (mode) => {
    h.mode = mode === "cloud" ? "cloud" : "local";
    await render(mode === "linked");
    expect(
      [...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Ollama")),
    ).toBe(false);
  },
);

// #1309: these images exit at first boot when this credential is blank, so a
// default Add saved a crash-looping service. Each now gets a generated value.
it.each([
  {
    image: "postgres:16-alpine",
    key: "POSTGRES_PASSWORD",
    rest: { POSTGRES_USER: "postgres", POSTGRES_DB: "app" },
  },
  { image: "mysql:8", key: "MYSQL_ROOT_PASSWORD", rest: { MYSQL_DATABASE: "app" } },
  { image: "mariadb:11", key: "MARIADB_ROOT_PASSWORD", rest: { MARIADB_DATABASE: "app" } },
  {
    image: "mongo:7",
    key: "MONGO_INITDB_ROOT_PASSWORD",
    rest: { MONGO_INITDB_ROOT_USERNAME: "root" },
  },
  {
    image: "typesense/typesense:26.0",
    key: "TYPESENSE_API_KEY",
    rest: { TYPESENSE_DATA_DIR: "/data" },
  },
])("generates $key for a default $image service", async ({ image, key, rest }) => {
  await render();
  await pick(image);
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledOnce();
  expect(sentEnv(0)).toEqual({ ...rest, [key]: expect.stringMatching(GENERATED) });
});
it("hides a generated password until revealed and lets the operator replace it", async () => {
  await render();
  await pick("postgres:16-alpine");
  const password = envRow("POSTGRES_PASSWORD");
  expect(password.value.type).toBe("password");
  expect(password.value.value).toMatch(GENERATED);
  expect(envRow("POSTGRES_USER").value.type).toBe("text");
  await act(async () => password.reveal!.click());
  expect(envRow("POSTGRES_PASSWORD").value.type).toBe("text");
  await typeInto(envRow("POSTGRES_PASSWORD").value, "operator-chosen");
  await act(async () => {
    submit();
  });
  expect(sentEnv(0).POSTGRES_PASSWORD).toBe("operator-chosen");
});
it("keeps the generated password when a failed save is retried", async () => {
  h.submit.mockRejectedValueOnce(new Error("Server unavailable"));
  await render();
  await pick("postgres:16-alpine");
  await act(async () => {
    submit();
  });
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledTimes(2);
  expect(sentEnv(0).POSTGRES_PASSWORD).toMatch(GENERATED);
  expect(sentEnv(1).POSTGRES_PASSWORD).toBe(sentEnv(0).POSTGRES_PASSWORD);
});
it("generates a different password for each new service", async () => {
  await render();
  await pick("postgres:16-alpine");
  await act(async () => {
    submit();
  });
  // The page closes the modal after a save and reopens it for the next Add.
  await render(false, false);
  await render();
  await pick("postgres:16-alpine");
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledTimes(2);
  expect(sentEnv(1).POSTGRES_PASSWORD).toMatch(GENERATED);
  expect(sentEnv(1).POSTGRES_PASSWORD).not.toBe(sentEnv(0).POSTGRES_PASSWORD);
});
it("sends an entry's catalog values unchanged when it has no generated key", async () => {
  await render();
  await pick("redis:7-alpine");
  await act(async () => {
    submit();
  });
  expect(sentEnv(0)).toEqual({ REDIS_PASSWORD: "" });
});

const repository: ServiceRepositorySource = {
  owner: "example",
  repo: "platform",
  branch: "dev",
  projectDirectory: "deploy/compose",
};
it.each(["cloud", "local", "linked"])(
  "creates a repository service with the existing Compose fields (%s)",
  async (mode) => {
    h.mode = mode === "cloud" ? "cloud" : "local";
    await render(mode === "linked", true, repository);
    await pick(copy.repositorySource.title);
    expect(host.textContent).toContain("example/platform");
    expect(host.textContent).toContain("dev");
    expect(h.tree).not.toHaveBeenCalled(); // Browser loads only when opened.
    await edit("api", "worker");
    await edit(".", "apps/api");
    await edit("Dockerfile", "apps/api/Dockerfile.prod");
    await edit("3000", "8080");
    await act(async () => {
      submit();
    });
    expect(h.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "worker",
        build: "../../apps/api",
        dockerfile: "Dockerfile.prod",
        image: "",
        ports: ["8080"],
      }),
    );
    expect(h.submit.mock.calls[0][0]).not.toHaveProperty("kind", "monorepo");
  },
);
it("browses actual repository folders and files before saving", async () => {
  await render(false, true, repository);
  await pick(copy.repositorySource.title);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(`[aria-label="${copy.repositorySource.browseContext}"]`)!
      .click(),
  );
  expect(h.tree).toHaveBeenCalledWith("example", "platform", "dev");
  await pick("apps");
  await pick("api");
  expect(host.querySelector<HTMLInputElement>('input[placeholder="."]')!.value).toBe("apps/api");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(`[aria-label="${copy.repositorySource.browseDockerfile}"]`)!
      .click(),
  );
  await pick("apps");
  await pick("api");
  await pick("Dockerfile.prod");
  expect(host.querySelector<HTMLInputElement>('input[placeholder="Dockerfile"]')!.value).toBe(
    "apps/api/Dockerfile.prod",
  );
  await edit("api", "backend");
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[0][0]).toMatchObject({
    build: "../../apps/api",
    dockerfile: "Dockerfile.prod",
  });
});
it("explains a missing repository and refuses invalid build paths inline", async () => {
  await render();
  await pick(copy.repositorySource.title);
  expect(host.textContent).toContain(copy.repositorySource.noRepository);
  expect(host.querySelector("form")).toBeNull();
  await render(false, true, repository);
  await pick(copy.repositorySource.title);
  await edit("api", "backend");
  await edit(".", "../outside");
  await act(async () => {
    submit();
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.repositorySource.invalidPath);
  await edit(".", "apps/api");
  await act(async () => {
    submit();
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    copy.repositorySource.outsideContext,
  );
  expect(h.submit).not.toHaveBeenCalled();
});
it("keeps manual paths and permits browsing retry when the repository read fails", async () => {
  h.tree.mockRejectedValueOnce(new Error("Source access unavailable"));
  await render(false, true, repository);
  await pick(copy.repositorySource.title);
  await edit("api", "backend");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(`[aria-label="${copy.repositorySource.browseContext}"]`)!
      .click(),
  );
  expect(host.textContent).toContain("Source access unavailable");
  await pick(baseDictionary.importProject.monorepo.selection.retry);
  await pick("apps");
  await edit(".", ".");
  h.submit.mockRejectedValueOnce(new Error("Cannot save"));
  await act(async () => {
    submit();
  });
  expect(host.textContent).toContain("Cannot save");
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[1][0]).toEqual(h.submit.mock.calls[0][0]);
});
it("never carries catalog secrets, argv, or GPU requests into repository builds", async () => {
  await render(false, true, repository);
  await pick(getAppTemplate("minio")!.services![0]!.image!);
  await pick(copy.repositorySource.title);
  await edit("api", "backend");
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[0][0]).toMatchObject({
    image: "",
    build: "../..",
    dockerfile: "Dockerfile",
    environment: {},
    volumes: [],
  });
  expect(h.submit.mock.calls[0][0]).not.toHaveProperty("commandArgv");
  expect(h.submit.mock.calls[0][0]).not.toHaveProperty("advanced");
});
it.each(["catalog", "repository", "image"])(
  "does not carry public routing to a different %s service",
  async (source) => {
    await render(false, true, repository);
    await pick(getAppTemplate("minio")!.services![0]!.image!);
    await pick("Configure public route");
    if (source === "catalog") {
      await act(async () =>
        host.querySelector<HTMLButtonElement>(`[aria-label="${copy.backToCatalog}"]`)!.click(),
      );
      await pick("redis:7-alpine");
    } else {
      await pick(source === "repository" ? copy.repositorySource.title : copy.customImage);
      await edit(source === "repository" ? "api" : "postgres", "backend");
      if (source === "image") await edit("postgres:16-alpine", "example/api:v1");
    }
    await act(async () => {
      submit();
    });
    expect(h.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        exposed: false,
        exposedPort: undefined,
        domain: undefined,
        customDomain: undefined,
        domainType: "free",
      }),
    );
  },
);
it("preserves edited fields and generated credentials when returning to the same catalog item", async () => {
  await render();
  await pick("postgres:16-alpine");
  const password = envRow("POSTGRES_PASSWORD").value.value;
  await edit("postgres", "orders");
  await edit("5432", "5433");
  await pick("Configure public route");
  await act(async () =>
    host.querySelector<HTMLButtonElement>(`[aria-label="${copy.backToCatalog}"]`)!.click(),
  );
  await pick("postgres:16-alpine");
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: "orders",
      ports: ["5433"],
      environment: expect.objectContaining({ POSTGRES_PASSWORD: password }),
      exposed: true,
      exposedPort: "9001",
      customDomain: "storage.example.test",
      domainType: "custom",
    }),
  );
});
it("discards the source draft when the project repository changes", async () => {
  await render(false, true, repository);
  await pick(copy.repositorySource.title);
  await edit("api", "old-service");
  await render(false, true, { ...repository, repo: "another" });
  await pick(copy.repositorySource.title);
  expect(host.textContent).toContain("example/another");
  expect(host.querySelector<HTMLInputElement>('input[placeholder="api"]')!.value).toBe("");
});
it("defaults new routing to custom domains without a Cloud connection", async () => {
  h.connected = false;
  await render();
  await pick("redis:7-alpine");
  await act(async () => {
    submit();
  });
  expect(h.submit.mock.calls[0][0].domainType).toBe("custom");
});

it("allows saving when the parent sets the request scope during mount", async () => {
  function Parent() {
    useLayoutEffect(() => {
      setApiResourceScope("newly-mounted-account");
    }, []);
    return (
      <I18nProvider>
        <AddServiceModal open projectName="Example" onClose={h.close} onSubmit={h.submit} />
      </I18nProvider>
    );
  }
  await act(async () => root.render(<Parent />));
  await pick("redis:7-alpine");
  await act(async () => {
    submit();
  });
  expect(h.submit).toHaveBeenCalledOnce();
});
