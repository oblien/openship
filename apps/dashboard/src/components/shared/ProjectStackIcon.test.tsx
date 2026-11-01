import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectStackIcon } from "./ProjectStackIcon";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";
import { I18nProvider } from "@/components/i18n-provider";
import { DeploymentCard } from "@/app/(dashboard)/deployments/components/DeploymentCard";
import { mapRowToDeployment } from "@/app/(dashboard)/deployments/utils";

vi.mock("@/app/(dashboard)/deployments/components/DeploymentMenu", () => ({
  DeploymentMenu: () => null,
}));
vi.mock("@/app/(dashboard)/deployments/components/CommitDetailsModal", () => ({
  CommitDetailsModal: () => null,
}));

describe("project and deployment icon identity", () => {
  it.each([undefined, null, "", "unknown", "unsupported-stack", "constructor", "__proto__"])(
    "does not label %s as HTML5",
    (framework) => {
      const html = renderToStaticMarkup(<ProjectStackIcon framework={framework} />);
      expect(html).toContain('data-icon="window"');
      expect(html).not.toContain("html5");
      expect(getFrameworkConfig(framework ?? "").id).toBe("unknown");
    },
  );

  it.each([null, "unknown", "docker-compose"])(
    "renders a service group for framework %s",
    (framework) => {
      const html = renderToStaticMarkup(
        <ProjectStackIcon framework={framework} serviceDeploymentMode="services" />,
      );
      expect(html).toContain('data-icon="layers"');
      expect(html).not.toContain("html5");
    },
  );

  it.each(["static", "nextjs", "docker"])(
    "keeps the recognized %s framework artwork",
    (framework) => {
      const html = renderToStaticMarkup(
        <ProjectStackIcon framework={framework} serviceDeploymentMode="services" />,
      );
      expect(html).toContain(`alt="${getFrameworkConfig(framework).name}"`);
      expect(html).not.toContain('data-icon="layers"');
    },
  );

  const deployment = (over = {}) =>
    mapRowToDeployment({
      id: "imported",
      projectId: "project",
      projectName: "Imported services",
      createdAt: new Date().toISOString(),
      status: "ready",
      framework: null,
      meta: { serviceDeploymentMode: "services", adopt: true },
      ...over,
    });
  it("reads an existing adopted deployment's saved execution mode through the real card", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DeploymentCard deployment={deployment()} />
      </I18nProvider>,
    );
    expect(html).toContain('data-icon="layers"');
    expect(html).not.toContain("html5");
  });

  it("keeps favicons ahead of the service-group fallback", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DeploymentCard deployment={deployment({ favicon: "/site.ico" })} />
      </I18nProvider>,
    );
    expect(html).toContain('src="/site.ico"');
    expect(html).not.toContain('data-icon="layers"');
  });
});
