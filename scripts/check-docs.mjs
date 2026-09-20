/** Validate navigation, links, MDX, and the published SDK/CLI documentation surface. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { docsDirectory, filesUnder, root, cliSurface } from "./docs-surface.mjs";
import { updateApiReference } from "./generate-api-reference.mjs";
import { renderCliReference } from "./generate-cli-reference.mjs";
import { checkDocExamples } from "./check-docs-examples.mjs";
import { checkCliExamples } from "./check-docs-cli.mjs";

// Resolve the actual website's parser and heading plugin. No separate parser,
// global CLI, Git executable, or search utility is needed on CI runners.
const webRequire = createRequire(join(root, "apps/web/package.json"));
const mdxRequire = createRequire(webRequire.resolve("fumadocs-mdx/package.json"));
const coreRequire = createRequire(webRequire.resolve("fumadocs-core/package.json"));
const { createProcessor } = await import(pathToFileURL(mdxRequire.resolve("@mdx-js/mdx")).href);
const { default: remarkGfm } = await import(pathToFileURL(coreRequire.resolve("remark-gfm")).href);
const { remarkHeading } = await import(
  pathToFileURL(webRequire.resolve("fumadocs-core/mdx-plugins/remark-heading")).href
);
const failures = [];
const pages = new Map();
const walk = (node, visit) => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const routeFor = (file) =>
  "/docs" +
  (
    "/" +
    relative(docsDirectory, file)
      .replaceAll("\\", "/")
      .replace(/\.mdx$/, "")
      .replace(/(?:^|\/)index$/, "")
  ).replace(/\/$/, "");

for (const file of filesUnder(docsDirectory, ".mdx")) {
  const raw = readFileSync(file, "utf8");
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (
    !frontmatter ||
    !/^title: \S/m.test(frontmatter[1]) ||
    !/^description: \S/m.test(frontmatter[1])
  )
    failures.push(`${relative(root, file)}: add a title and description`);
  const content = raw.slice(frontmatter?.[0].length ?? 0);
  const route = routeFor(file);
  if (pages.has(route)) failures.push(`Duplicate documentation URL: ${route}`);
  const page = { file, ids: new Set(), links: [] };
  pages.set(route, page);
  try {
    let document;
    const processor = createProcessor({
      remarkPlugins: [
        remarkGfm,
        [remarkHeading, { generateToc: false }],
        () => (tree) => {
          document = tree;
        },
      ],
    });
    await processor.process(content);
    walk(document, (node) => {
      if (node.type === "heading" && node.data?.hProperties?.id)
        page.ids.add(node.data.hProperties.id);
      if (node.type === "link" || node.type === "definition") page.links.push(node.url);
      for (const attribute of node.attributes ?? []) {
        if (attribute.name === "href" && typeof attribute.value === "string")
          page.links.push(attribute.value);
        if (attribute.name === "id" && typeof attribute.value === "string")
          page.ids.add(attribute.value);
      }
    });
  } catch (error) {
    failures.push(`${relative(root, file)}: ${error.message}`);
  }
  if (/Screenshot pending|REST reference pending/.test(content))
    failures.push(`${relative(root, file)}: remove unfinished documentation placeholders`);
}

for (const [route, page] of pages) {
  for (const link of page.links) {
    if (
      !link.startsWith("/docs") &&
      !link.startsWith("#") &&
      !link.startsWith("https://openship.io/docs")
    )
      continue;
    const url = new URL(link, "https://openship.io" + route);
    const targetRoute = url.pathname.replace(/\.md$/, "").replace(/\/$/, "");
    const target = pages.get(targetRoute);
    if (!target) failures.push(`${relative(root, page.file)}: missing page ${link}`);
    else if (url.hash && !target.ids.has(decodeURIComponent(url.hash.slice(1))))
      failures.push(`${relative(root, page.file)}: missing heading ${link}`);
  }
}

for (const metaFile of filesUnder(docsDirectory, "meta.json")) {
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  if (!Array.isArray(meta.pages)) continue;
  const directory = dirname(metaFile);
  const explicit = new Set();
  for (const entry of meta.pages) {
    if (entry.startsWith("---") || entry.startsWith("[") || entry.startsWith("!")) continue;
    if (entry === "...") continue;
    const candidate = join(directory, entry);
    if (
      !existsSync(candidate + ".mdx") &&
      !(
        existsSync(candidate) &&
        readdirSync(candidate).some((name) => name.endsWith(".mdx") || name === "meta.json")
      )
    )
      failures.push(`${relative(root, metaFile)}: missing navigation entry ${entry}`);
    if (explicit.has(entry))
      failures.push(`${relative(root, metaFile)}: repeated navigation entry ${entry}`);
    explicit.add(entry);
  }
  if (!meta.pages.includes("...")) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name =
        entry.isFile() && entry.name.endsWith(".mdx")
          ? entry.name.slice(0, -4)
          : entry.isDirectory() && filesUnder(join(directory, entry.name), ".mdx").length
            ? entry.name
            : undefined;
      if (name && !explicit.has(name) && !meta.pages.includes("!" + name))
        failures.push(`${relative(root, metaFile)}: page/folder missing from navigation: ${name}`);
    }
  }
}

if (failures.length) throw new Error([...new Set(failures)].join("\n"));
console.log(`${pages.size} documentation pages compile; navigation and internal links resolve.`);
const api = updateApiReference();
console.log(
  `${api.methodCount} SDK methods and ${api.routeCount} HTTP routes have one shared reference.`,
);
const cli = await cliSurface();
const reference = renderCliReference(cli);
const cliDirectory = join(docsDirectory, "cli/reference");
for (const [file, expected] of reference) {
  if (readFileSync(join(cliDirectory, file), "utf8") !== expected)
    throw new Error(`Stale CLI reference: ${file}. Run bun run docs:reference.`);
}
for (const file of filesUnder(cliDirectory, ".mdx")) {
  if (!reference.has(relative(cliDirectory, file).replaceAll("\\", "/")))
    throw new Error(`Obsolete CLI reference: ${relative(root, file)}`);
}
console.log(`${cli.length} CLI command paths match the built public CLI.`);
console.log(`${checkCliExamples(cli)} CLI examples use current commands and options.`);
console.log(`${checkDocExamples()} SDK examples type-check against the public package.`);
