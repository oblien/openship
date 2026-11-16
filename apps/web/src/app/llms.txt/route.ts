import { PRODUCT_SUMMARY, CONTROL_PLANE_MODES, PRODUCT_ADVANTAGES } from "@/lib/product";
import { SITE_URL } from "@/lib/sitemap-builder";

export const dynamic = "force-static";

/** Concise product context; detailed catalogs live behind the linked Markdown pages. */
export function GET() {
  const lines = [
    "# OpenShip",
    "",
    `> ${PRODUCT_SUMMARY}`,
    "",
    ...CONTROL_PLANE_MODES.map((mode) => `${mode.title}: ${mode.description}\n`),
    "## Capabilities",
    ...Object.values(PRODUCT_ADVANTAGES).map(
      (item) => `- [${item.title}](${SITE_URL}/features/${item.feature}.md): ${item.description}`,
    ),
    "",
    "## Product and migration",
    `- [Complete feature catalog](${SITE_URL}/features.md): feature details, availability, deployment modes and common questions.`,
    `- [Platform comparisons](${SITE_URL}/compare.md): OpenShip advantages, provider capabilities, official sources and migration paths.`,
    `- [Migration guides](${SITE_URL}/migrate): guided platform imports, Docker server imports and repository/data migration.`,
    `- [Pricing](${SITE_URL}/pricing): current managed Cloud and server-management plans.`,
    `- [Cloud SLA](${SITE_URL}/sla): coverage, service credits and claim requirements.`,
    "",
    "## Technical documentation",
    `- [Documentation index](${SITE_URL}/docs/llms.txt): every documentation page with a Markdown link.`,
    `- [Runtime model](${SITE_URL}/docs/architecture/runtime-model.md): controllers, destinations, build placement and traffic routing.`,
    `- [Clusters and scaling](${SITE_URL}/docs/guides/mcp-clusters-and-scaling.md): k3s, connected Swarm, replicas, databases and shared storage, including prerequisites and limits.`,
    `- [Backups and restore](${SITE_URL}/docs/guides/backups-restore.md): schedules, destinations, retention and recovery.`,
    `- [API](${SITE_URL}/docs/api.md): shared operations for the dashboard, CLI, SDK and MCP.`,
    "",
    "## Optional",
    `- [Complete product and documentation text](${SITE_URL}/llms-full.txt): the English product catalog, comparisons and technical documentation in one file.`,
    `- [Source code](https://github.com/oblien/openship): Apache 2.0 codebase and release history.`,
    "",
    "Public product pages are available in English, Arabic, German, Spanish, French, Japanese, Portuguese, Russian, Turkish and Chinese. Localized feature and comparison pages also have a .md representation, for example /ar/features.md and /fr/compare/dokploy.md. Technical documentation is in English.",
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
