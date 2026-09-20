/** Keep one SDK/REST operation catalog on each resource page. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docsDirectory, root, sdkSurface, httpSurface } from "./docs-surface.mjs";

const start = "{/* api-operations:start */}";
const end = "{/* api-operations:end */}";
const cell = (value) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (value) => "`" + cell(value) + "`";

export function renderApiReference() {
  const manifest = JSON.parse(readFileSync(join(root, "scripts/docs-api-reference.json"), "utf8"));
  const methods = new Map(
    sdkSurface().flatMap(({ group, methods }) =>
      methods.map((method) => [`${group}.${method.name}`, { ...method, group }]),
    ),
  );
  const routes = new Map();
  for (const route of httpSurface()) {
    const key = `${route.method} ${route.path}`;
    const variants = routes.get(key) ?? [];
    variants.push(route);
    routes.set(key, variants);
  }
  const pages = new Map();
  const coveredRoutes = new Set();
  function add(entry, sdk, route) {
    if (!entry.page || !entry.description)
      throw new Error(`Missing documentation for ${sdk ?? route}`);
    if (route && !routes.has(route)) throw new Error(`Documented route no longer exists: ${route}`);
    if (route && coveredRoutes.has(route)) throw new Error(`Route documented twice: ${route}`);
    if (route) coveredRoutes.add(route);
    const rows = pages.get(entry.page) ?? [];
    rows.push({ ...entry, sdk, route });
    pages.set(entry.page, rows);
  }
  for (const [key, entry] of Object.entries(manifest.methods)) {
    const method = methods.get(key);
    if (!method) throw new Error(`Documented SDK method no longer exists: ${key}`);
    add(
      entry,
      method.calls.map((call) => code(`${method.group}.${call}`)).join("<br />"),
      entry.route,
    );
    methods.delete(key);
  }
  if (methods.size)
    throw new Error(`SDK methods need documentation: ${[...methods.keys()].join(", ")}`);
  for (const [route, entry] of Object.entries(manifest.http))
    add(entry, entry.sdk ? code(entry.sdk) : undefined, route);
  const missingRoutes = [...routes.keys()].filter((key) => !coveredRoutes.has(key));
  if (missingRoutes.length)
    throw new Error(`HTTP routes need documentation: ${missingRoutes.join(", ")}`);

  const rendered = new Map();
  for (const [page, rows] of pages) {
    const sections = new Map();
    for (const row of rows) {
      const section = row.section ?? "HTTP endpoints";
      const sectionRows = sections.get(section) ?? [];
      sectionRows.push(row);
      sections.set(section, sectionRows);
    }
    const onlyHttp = rows.every((row) => !row.sdk);
    const content = [];
    for (const [section, sectionRows] of sections) {
      if (sections.size > 1)
        content.push(`### ${section === "Operations" ? "Resource methods" : section}\n`);
      content.push(
        onlyHttp
          ? "| Operation | REST API |\n| --- | --- |"
          : "| Operation | SDK | REST API |\n| --- | --- | --- |",
      );
      for (const row of sectionRows) {
        const variants = row.route ? routes.get(row.route) : [];
        const access = [...new Set(variants.map((variant) => variant.access))]
          .map(code)
          .join(" / ");
        const availability =
          variants.length && variants.every((variant) => variant.localOnly) ? " · Self-hosted" : "";
        const rest = row.route
          ? `${code(row.route)}<br />${access}${availability}`
          : `[Upload workflow](${row.workflow})`;
        content.push(
          onlyHttp
            ? `| ${cell(row.description)} | ${rest} |`
            : `| ${cell(row.description)} | ${row.sdk ?? "HTTP only"} | ${rest} |`,
        );
      }
      content.push("");
    }
    rendered.set(`api/${page}.mdx`, content.join("\n").trim());
  }
  return { rendered, methodCount: Object.keys(manifest.methods).length, routeCount: routes.size };
}

export function updateApiReference(write = false) {
  const result = renderApiReference();
  for (const [relative, block] of result.rendered) {
    const file = join(docsDirectory, relative);
    const previous = readFileSync(file, "utf8");
    if (previous.split(start).length !== 2 || previous.split(end).length !== 2)
      throw new Error(`Missing or repeated operation markers in ${relative}`);
    const next =
      previous.slice(0, previous.indexOf(start) + start.length) +
      "\n\n" +
      block +
      "\n\n" +
      previous.slice(previous.indexOf(end));
    if (write) writeFileSync(file, next);
    else if (next !== previous)
      throw new Error(`Stale API catalog: ${relative}. Run bun run docs:reference.`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = updateApiReference(process.argv.includes("--write"));
  console.log(
    `${result.methodCount} SDK methods and ${result.routeCount} HTTP routes across ${result.rendered.size} shared resource pages.`,
  );
}
