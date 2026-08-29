// No DOM needed: renderToStaticMarkup runs no effects, and the row is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import type { Project } from "@/constants/mock";
import ProjectCard from "./ProjectCard";

/**
 * Two lies this row used to tell, both seen in the field on one Convex app:
 *
 *   1. With no route at all it printed `<slug>.<baseDomain>` — "convex.opsh.io"
 *      in the Apps list, while that project's own Domains page said "No domain".
 *   2. With a failed latest deploy it printed the green "Live" pill, because the
 *      status derivation returned live on `activeDeploymentId` before it ever
 *      looked at the failure.
 */

const project = (over: Partial<Project> & { primaryDomain?: string | null }) =>
  ({
    id: "p1",
    name: "Convex",
    slug: "convex",
    framework: "docker",
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    ...over,
  }) as Project & { primaryDomain?: string | null };

function render(p: Project & { primaryDomain?: string | null }) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ModalProvider>
        <ProjectCard project={p} />
      </ModalProvider>
    </I18nProvider>,
  );
}

/** Strip tags so assertions read against what the user actually sees. */
function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("ProjectCard — hostname", () => {
  it("prints no hostname for a project with no persisted route", () => {
    const out = text(render(project({ activeDeploymentId: "d1" })));
    expect(out).toContain("Convex");
    expect(out).not.toContain("convex.");
    expect(out).not.toContain("opsh.io");
  });

  it("prints the persisted primary route when there is one", () => {
    const out = text(render(project({ primaryDomain: "convex.example.com" })));
    expect(out).toContain("convex.example.com");
  });
});

describe("ProjectCard — status pill", () => {
  it("does not read Live when the latest deploy failed", () => {
    const out = text(
      render(
        project({
          activeDeploymentId: "d1",
          latestDeploymentId: "d2",
          latestDeploymentStatus: "failed",
        }),
      ),
    );
    expect(out).toContain("Action Required");
    expect(out).not.toContain("Live");
  });

  it("reads Failed when the failed deploy is all the project has", () => {
    const out = text(
      render(project({ latestDeploymentId: "d1", latestDeploymentStatus: "failed" })),
    );
    expect(out).toContain("Failed");
    expect(out).not.toContain("Live");
  });

  it("still reads Live for a healthy release", () => {
    const out = text(render(project({ activeDeploymentId: "d1" })));
    expect(out).toContain("Live");
  });
});
