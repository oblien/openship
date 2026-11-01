import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import type { ComposeServiceInfo } from "@/context/deployment/types";
import { composeEnvironmentPreview, editComposeEnvironment } from "./compose-environment-preview";

const saved = (): ComposeServiceInfo => ({
  serviceId: "svc-console",
  name: "console",
  ports: [],
  dependsOn: [],
  volumes: [],
  environment: {
    BASE_URL: "${BASE_URL:-https://console.example.com}",
    POSTGRES_DB: "${POSTGRES_DB:-application}",
    NODE_ENV: "production",
  },
  advanced: { environmentTemplateKeys: ["BASE_URL", "POSTGRES_DB"] },
});

describe("Compose wizard effective environment", () => {
  it("shows saved defaults and current project overrides without rewriting the source", () => {
    const service = saved();
    const before = structuredClone(service);
    const preview = composeEnvironmentPreview(service, [
      { key: "POSTGRES_DB", value: "live-db", visible: true },
    ]);
    expect(preview.environment).toEqual({
      BASE_URL: "https://console.example.com",
      POSTGRES_DB: "live-db",
      NODE_ENV: "production",
    });
    expect(service).toEqual(before);
    expect(
      editComposeEnvironment(service, preview.environment, preview.environment).environment,
    ).toEqual(before.environment);
  });

  it("resolves dependent templates and reports unmet required variables through the canonical parser", () => {
    const service: ComposeServiceInfo = {
      ...saved(),
      environment: {
        URL: "postgres://${USER:-app}:${PASSWORD:?required}@${HOST:-db}/${DB}",
        DB: "${DB:-application}",
      },
      advanced: { environmentTemplateKeys: ["URL", "DB"] },
    };
    const missing = composeEnvironmentPreview(service, []);
    expect(missing.environment.URL).toBe("postgres://app:@db/application");
    expect(missing.environmentMeta.URL).toMatchObject({
      required: true,
      unresolvedVariables: ["PASSWORD"],
    });
    const supplied = composeEnvironmentPreview(service, [
      { key: "PASSWORD", value: "secret", visible: false },
    ]);
    expect(supplied.environment.URL).toBe("postgres://app:secret@db/application");
    expect(supplied.environmentMeta.URL.required).toBeUndefined();
  });

  it("keeps new-scan preview values separate from their original expressions when another row changes", () => {
    const service: ComposeServiceInfo = {
      ...saved(),
      serviceId: undefined,
      environment: { POSTGRES_DB: "application", NODE_ENV: "production" },
      environmentTemplates: { POSTGRES_DB: "${POSTGRES_DB:-application}" },
      advanced: { environmentTemplateKeys: ["POSTGRES_DB"] },
    };
    const view = composeEnvironmentPreview(service, []);
    const edited = editComposeEnvironment(service, view.environment, {
      ...view.environment,
      NODE_ENV: "test",
    });
    expect(edited.environmentTemplates).toEqual(service.environmentTemplates);
    expect(edited.advanced?.environmentTemplateKeys).toEqual(["POSTGRES_DB"]);
    expect(edited.environment).toEqual({ POSTGRES_DB: "application", NODE_ENV: "test" });
  });

  it("makes an explicit edit a literal, while retaining untouched templates and their future defaults", () => {
    const service = saved();
    const view = composeEnvironmentPreview(service, []);
    const edited = editComposeEnvironment(service, view.environment, {
      ...view.environment,
      BASE_URL: "https://other.example.com/${literal}",
    });
    expect(edited.advanced?.environmentTemplateKeys).toEqual(["POSTGRES_DB"]);
    expect(edited.environment?.POSTGRES_DB).toBe(service.environment.POSTGRES_DB);
    expect(composeEnvironmentPreview({ ...service, ...edited }, []).environment.BASE_URL).toBe(
      "https://other.example.com/${literal}",
    );
  });

  it("does not display partial strings containing masked project secrets", () => {
    const service = {
      ...saved(),
      environment: { URL: "https://${TOKEN}@example.com" },
      advanced: { environmentTemplateKeys: ["URL"] },
    };
    const view = composeEnvironmentPreview(service, [
      { key: "TOKEN", value: "", visible: false, preserveValue: true },
    ]);
    expect(view.environment.URL).toBe(ENV_MASK);
    expect(view.environmentMeta.URL.resolvedValue).toBe(ENV_MASK);
    expect(
      editComposeEnvironment(service, view.environment, view.environment).environment?.URL,
    ).toBe(service.environment.URL);
  });

  it("expands escaped dollars once and preserves literal dollars without a template marker", () => {
    const service = {
      ...saved(),
      environment: { TEMPLATE: "$${literal}", LITERAL: "${literal}" },
      advanced: { environmentTemplateKeys: ["TEMPLATE"] },
    };
    expect(composeEnvironmentPreview(service, []).environment).toEqual({
      TEMPLATE: "${literal}",
      LITERAL: "${literal}",
    });
  });
});
