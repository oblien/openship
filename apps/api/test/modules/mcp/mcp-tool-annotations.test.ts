import { beforeEach, describe, expect, it } from "vitest";
import "../../../src/modules/projects/project.routes";
import "../../../src/modules/projects/project-storage.routes";
import "../../../src/modules/services/service.routes";
import "../../../src/modules/deployments/deployment.routes";
import "../../../src/modules/domains/domain.routes";
import { getMcpTools, resetMcpToolCache, toClientTool } from "../../../src/modules/mcp/mcp-tools";

function clientTool(name: string) {
  const tool = getMcpTools().find((entry) => entry.name === name);
  expect(tool, `Missing advertised tool: ${name}`).toBeDefined();
  return toClientTool(tool!);
}

describe("MCP client-facing destructive annotations", () => {
  beforeEach(resetMcpToolCache);

  // These write operations can remove data, replace configuration or disrupt
  // running workloads without using DELETE or an admin permission tag.
  it.each([
    "post_projects_by_id_route_rules",
    "patch_projects_by_id_route_rules_by_ruleId",
    "post_projects_by_id_previews",
    "patch_projects_by_id_env",
    "post_projects_by_id_incoming_webhooks_by_hookId_rotate",
    "post_projects_by_id_storage",
    "post_deployments_by_id_reject",
    "post_deployments_by_id_build_respond",
    "post_domains_by_id_dns_challenge_cancel",
    "post_domains_by_id_certificate",
    "post_projects_by_id_services_sync",
    "post_projects_by_id_services_by_serviceId_exec",
    "patch_projects_by_id_services_by_serviceId",
    "patch_projects_by_id_services_by_serviceId_env",
    "put_projects_by_id_services_by_serviceId_env",
  ])("advertises the destructive potential of %s", (name) => {
    expect(clientTool(name).annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it.each([
    "get_projects_by_id_route_rules",
    "get_projects_by_id_previews",
    "get_projects_by_id_env",
    "get_projects_by_id_storage",
    "get_projects_by_id_services_by_serviceId",
    "get_projects_by_id_services_by_serviceId_env",
    "get_deployments_by_id_pending",
    "get_domains_by_id_dns_challenge",
  ])("keeps the inspection tool %s read-only", (name) => {
    expect(clientTool(name).annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});
