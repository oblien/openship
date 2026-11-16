import {
  normalizeEdgePages,
  compileEdgePages,
  type CompiledEdgePages,
  type EdgePages,
} from "@repo/core";
import { encodeConfigData, luaConfigData } from "./lua-data";

export const EDGE_PAGES_FILE = "_openship-pages.conf";
const moduleName = 'require("openship.edge_pages")';

/** Literal base64 data is the only user-controlled material in generated directives. */
export function renderEdgePageFilters(
  pages?: CompiledEdgePages | null,
  protectedRoute = false,
): string {
  const argument = pages ? luaConfigData(pages) : "nil";
  return `    header_filter_by_lua_block { ${protectedRoute ? 'require("openship.response_headers").private(); ' : ""}${moduleName}.headers(${argument}) }
    body_filter_by_lua_block { ${moduleName}.body() }
`;
}

export function renderMaintenanceGuard(pages?: CompiledEdgePages | null): string {
  return pages?.maintenance?.enabled
    ? `        ${moduleName}.maintenance(${luaConfigData(pages)})\n`
    : "";
}

export function renderServerEdgePages(input: EdgePages): string {
  const config = normalizeEdgePages(input, "server");
  return `# Openship server pages v1\n${encodeConfigData(config)
    .map((chunk) => `# configuration:${chunk}`)
    .join("\n")}
init_by_lua_block { ${moduleName}.set_defaults(${luaConfigData(compileEdgePages(config))}) }
${renderEdgePageFilters()}`;
}

export function readServerEdgePages(config: string): EdgePages {
  const encoded = [...config.matchAll(/^# configuration:([A-Za-z0-9+/=]+)$/gm)]
    .map((match) => match[1])
    .join("");
  if (!encoded)
    throw new Error(
      "Server edge pages could not be read. The saved configuration was left unchanged.",
    );
  return normalizeEdgePages(JSON.parse(Buffer.from(encoded, "base64").toString()), "server");
}
