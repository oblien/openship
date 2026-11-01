/** Audit all routes and publish the same MCP descriptions used at runtime. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docsDirectory, httpSurface } from "./docs-surface.mjs";
import { mcpToolName } from "../apps/api/src/modules/mcp/mcp-name.mjs";

const protectedModules = new Set(["auth", "tokens", "mcp"]);
const key = (route) => `${route.method} ${route.path}`;

export function mcpSurface(routes = httpSurface()) {
  const endpoints = new Map();
  for (const route of routes) {
    if (route.mcp && (protectedModules.has(route.module) || !/:\w+$/.test(route.access)))
      throw new Error(`Non-tool surface opted into MCP: ${key(route)}`);
    if (route.mcp && (!route.mcp.description?.trim() || route.path.endsWith("/stream")))
      throw new Error(`MCP needs a JSON operation and a description: ${key(route)}`);
    const reason =
      route.mcpExcluded ??
      (protectedModules.has(route.module)
        ? "Authentication, credential issuance or MCP transport. These modules cannot become tools."
        : undefined) ??
      route.publicReason ??
      (route.access === "Internal operator"
        ? "Internal desktop/operator transport; not a user MCP operation."
        : undefined) ??
      (route.module === "images"
        ? "Image upload/download uses binary HTTP transport."
        : undefined) ??
      (route.access === "Public" ||
      route.access === "Browser callback" ||
      route.access === "Handler authentication"
        ? "Public discovery or callback with its own HTTP authentication/transport."
        : undefined);
    if (!route.mcp && !reason)
      throw new Error(
        `Classify MCP coverage on ${key(route)} (${route.source}): add mcp or mcpExcluded.`,
      );
    const existing = endpoints.get(key(route));
    if (existing) {
      if (JSON.stringify(existing.mcp) !== JSON.stringify(route.mcp))
        throw new Error(`Mode variants disagree on MCP metadata: ${key(route)}`);
      existing.localOnly &&= route.localOnly;
    } else endpoints.set(key(route), { ...route, reason });
  }
  const tools = [];
  const httpOnly = [];
  const names = new Set();
  for (const route of endpoints.values()) {
    if (!route.mcp) {
      httpOnly.push(route);
      continue;
    }
    const name = mcpToolName(route.method, route.path);
    if (names.has(name)) throw new Error(`MCP tool name collision: ${name}`);
    names.add(name);
    tools.push({ ...route, name });
  }
  tools.sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  return { tools, httpOnly };
}

const cell = (text) =>
  String(text)
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .replace(/[<>{}]/g, (char) => `&#${char.charCodeAt(0)};`);
const code = (text) => "`" + text + "`";

export function renderMcpReference(surface = mcpSurface()) {
  const { tools, httpOnly } = surface;
  const content = [
    "---",
    "title: MCP tool catalog",
    "description: Generated tool descriptions, API mappings, availability, and intentional HTTP-only routes.",
    "---",
    "",
    "This catalog is generated from the route metadata used by MCP discovery. Run `tools/list` against your instance for its current input schemas and the tools available to your credential. See [MCP setup](/docs/mcp), [protocol and arguments](/docs/api/mcp), and the [cluster/scaling workflow](/docs/guides/mcp-clusters-and-scaling).",
    "",
    `The current API has **${tools.length} unique tools**. Permission tags below describe the route's initial authority; shared operations also enforce workspace, resource, source-access and instance-admin requirements. Self-hosted tools are unavailable on the hosted Cloud controller.`,
    "",
    "## Tools",
    "",
  ];
  for (const module of [...new Set(tools.map((tool) => tool.module))]) {
    content.push(
      `### ${module}`,
      "",
      "| Tool and HTTP route | Description | Access |",
      "| --- | --- | --- |",
    );
    for (const tool of tools.filter((tool) => tool.module === module)) {
      content.push(
        `| ${code(tool.name)}<br />${code(key(tool))} | ${cell(tool.mcp.description)} | ${code(tool.access)}${tool.localOnly ? "<br />Self-hosted" : ""} |`,
      );
    }
    content.push("");
  }
  content.push(
    "## HTTP-only routes",
    "",
    "Every remaining route has an explicit boundary: browser authorization, streaming/binary transport, internal relay, compatibility alias, or an operator workflow. These exclusions do not remove HTTP functionality. The documentation check fails if a new authenticated route has neither MCP metadata nor an exclusion reason.",
    "",
    "| HTTP route | Why it is not an MCP tool |",
    "| --- | --- |",
  );
  for (const route of httpOnly) content.push(`| ${code(key(route))} | ${cell(route.reason)} |`);
  return content.join("\n") + "\n";
}

export function updateMcpReference(write = false) {
  const surface = mcpSurface();
  const file = join(docsDirectory, "api/mcp-tools.mdx");
  const expected = renderMcpReference(surface);
  if (write) writeFileSync(file, expected);
  else if (readFileSync(file, "utf8") !== expected)
    throw new Error("Stale MCP reference. Run bun run docs:reference.");
  return surface;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = updateMcpReference(process.argv.includes("--write"));
  console.log(
    `${result.tools.length} MCP tools; ${result.httpOnly.length} intentional HTTP-only routes.`,
  );
}
