import { docEntries } from "@/lib/llms";
import { SITE_URL } from "@/lib/sitemap-builder";

/**
 * `/llms.txt` — the catalog of OpenShip docs for LLMs/agents, per the
 * https://llmstxt.org convention. Every entry links to the raw-markdown (`.md`)
 * variant of the doc so an agent can fetch clean source, no HTML.
 */
export const dynamic = "force-static";

const SUMMARY =
  "OpenShip is an open-source platform to build, deploy, and run apps on your own servers or OpenShip Cloud, managed from a dashboard, REST API, CLI, and MCP.";

export function GET() {
  const docs = docEntries();

  const lines = [
    "# OpenShip",
    "",
    `> ${SUMMARY}`,
    "",
    "## Docs",
    ...docs.map((d) => `- [${d.title}](${d.mdUrl})${d.description ? `: ${d.description}` : ""}`),
    "",
    "## Compare and migrate",
    `- [Platform comparisons](${SITE_URL}/compare): hosting models, tradeoffs, official sources and migration paths.`,
    `- [Migration guides](${SITE_URL}/migrate): guided platform imports, Docker server imports and manual migration.`,
    `- [Cloud SLA](${SITE_URL}/sla): uptime coverage, service credits and claims.`,
    "",
    "## Optional",
    `- [All docs as one file](${SITE_URL}/llms-full.txt): every page above concatenated as markdown.`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
