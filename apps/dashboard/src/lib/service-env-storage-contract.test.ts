import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(dashboard)/projects/[id]/components/services/ServiceDetailPanel.tsx",
  ),
  "utf8",
);

describe("service Environment tab storage ownership", () => {
  it("writes service-scoped env_var rows instead of compose-owned service.environment", () => {
    expect(panel).toContain("servicesApi.setEnv(projectId, service.id");
    expect(panel).toContain("servicesApi.getEnv(projectId, service.id");
    expect(panel).toContain("sourceId: v.id");
    expect(panel).toContain("sourceId: row.sourceId");
    expect(panel).not.toContain("serviceEnvPatch(");
  });
});
