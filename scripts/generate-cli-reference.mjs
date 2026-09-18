/** Generate command syntax from the built public CLI; no command actions run. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliSurface, docsDirectory } from "./docs-surface.mjs";

const categories = {
  Connect: ["login", "logout", "context", "token", "api"],
  Deploy: ["init", "config", "deploy", "deployment", "logs"],
  Applications: ["project", "app", "service", "domain"],
  Infrastructure: ["job", "server", "backup", "edge", "mail", "system"],
  "Local installation": [
    "up",
    "stop",
    "status",
    "doctor",
    "open",
    "install",
    "update",
    "uninstall",
    "reset-admin-password",
  ],
  Shell: ["completion"],
};
const guides = {
  login: "access",
  logout: "access",
  context: "access",
  token: "access",
  api: "access",
  init: "projects",
  config: "projects",
  deploy: "deploy",
  deployment: "deploy",
  logs: "deploy",
  project: "projects",
  app: "projects",
  service: "projects",
  domain: "projects",
  job: "../guides/jobs",
  server: "self-host",
  backup: "self-host",
  edge: "edge",
  mail: "self-host",
  system: "self-host",
};
const syntax = (value) => "`" + value.replaceAll("|", "\\|") + "`";
const prose = (value) =>
  value
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part.replaceAll("|", "\\|")
        : part
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll("{", "&#123;")
            .replaceAll("}", "&#125;")
            .replaceAll("|", "\\|"),
    )
    .join("");
const slug = (command) => command.split(" ").slice(1).join("/");
const anchor = (command) => command.replaceAll(" ", "-");
const descendants = (catalog, command) =>
  catalog.filter((entry) => entry.command === command || entry.command.startsWith(command + " "));

export function renderCliReference(catalog) {
  const top = catalog.filter((entry) => entry.command.split(" ").length === 2);
  const expected = new Set(Object.values(categories).flat());
  if (
    top.length !== expected.size ||
    top.some((entry) => !expected.has(entry.command.split(" ")[1]))
  )
    throw new Error(
      "Categorize every current top-level CLI command before generating the reference",
    );
  const selected = new Set(top.map((entry) => entry.command));
  for (const entry of catalog) {
    if (entry.command.split(" ").length < 3 || entry.children.length < 2) continue;
    const size = descendants(catalog, entry.command).reduce(
      (n, row) => n + 8 + row.options.length * 2 + row.arguments.length,
      0,
    );
    if (size >= 60) selected.add(entry.command);
  }
  const owner = (command) =>
    [...selected]
      .filter((candidate) => command === candidate || command.startsWith(candidate + " "))
      .sort((a, b) => b.length - a.length)[0];
  const link = (command) => `/docs/cli/reference/${slug(owner(command))}#${anchor(command)}`;
  const files = new Map();
  for (const command of selected) {
    const name = command.split(" ").slice(1).join(" ");
    const family = command.split(" ")[1];
    let body = `---\ntitle: ${name}\ndescription: Commands, arguments, and options for ${command}.\ncliGroup: ${command}\n---\n\n`;
    body += `See the [${guides[family] ? "workflow guide" : "CLI overview"}](/docs/cli${guides[family] ? "/" + guides[family] : ""}) for examples. `;
    body += `Global flags such as \`--json\` go before the command; see [global options](/docs/cli/reference#global-options).\n\n`;
    for (const entry of catalog.filter((entry) => owner(entry.command) === command)) {
      body += `## ${entry.command}\n\n${prose(entry.description) || "Use this command with the arguments below."}\n\n\`\`\`text\n${entry.usage}\n\`\`\`\n\n`;
      if (entry.children.length) {
        body += "| Subcommand | Purpose |\n| --- | --- |\n";
        for (const child of entry.children) {
          const childCommand = entry.command + " " + child.syntax.split(/[ |]/)[0];
          body += `| [${syntax(child.syntax)}](${link(childCommand)}) | ${prose(child.description)} |\n`;
        }
        body += "\n";
      }
      if (entry.arguments.length) {
        body += "| Argument | Meaning |\n| --- | --- |\n";
        for (const argument of entry.arguments)
          body += `| ${syntax(argument.syntax)} | ${prose(argument.description)} |\n`;
        body += "\n";
      }
      const options = entry.options.filter((option) => !option.syntax.includes("--help"));
      if (options.length) {
        body += "| Option | Meaning |\n| --- | --- |\n";
        for (const option of options)
          body += `| ${syntax(option.syntax)} | ${prose(option.description)} |\n`;
        body += "\n";
      }
    }
    files.set(`${slug(command)}/index.mdx`, body.trimEnd() + "\n");
    const children = [...selected].filter(
      (candidate) =>
        candidate.startsWith(command + " ") &&
        owner(candidate.split(" ").slice(0, -1).join(" ")) === command,
    );
    files.set(
      `${slug(command)}/meta.json`,
      JSON.stringify(
        {
          title: command.split(" ").at(-1),
          pages: [
            "index",
            ...children.map((child) => child.split(" ").slice(command.split(" ").length).join("/")),
          ],
        },
        null,
        2,
      ) + "\n",
    );
  }
  let index =
    "---\ntitle: CLI command reference\ndescription: Every public CLI command, argument, and option, grouped by task.\n---\n\n";
  index +=
    "Use `openship <command> --help` to check the version installed on your machine. `<value>` is required; `[value]` is optional. Aliases appear beside the command name.\n\n";
  index += "## Global options\n\n| Option | Meaning |\n| --- | --- |\n";
  for (const option of catalog.find((entry) => entry.command === "openship").options)
    index += `| ${syntax(option.syntax)} | ${prose(option.description)} |\n`;
  index +=
    "\nPut global options before the command, for example `openship --json project list`. See [native mode](/docs/cli/native) before using `--native-config`.\n\n";
  const pages = ["index"];
  for (const [category, names] of Object.entries(categories)) {
    index += `## ${category}\n\n| Command | Purpose |\n| --- | --- |\n`;
    pages.push(`---${category}---`, ...names);
    for (const name of names) {
      const entry = top.find((entry) => entry.command === "openship " + name);
      index += `| [${syntax(entry.command)}](/docs/cli/reference/${name}) | ${prose(entry.description)} |\n`;
    }
    index += "\n";
  }
  files.set("index.mdx", index.trimEnd() + "\n");
  files.set("meta.json", JSON.stringify({ title: "Command reference", pages }, null, 2) + "\n");
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = await cliSurface();
  const output = join(docsDirectory, "cli/reference");
  const generated = renderCliReference(catalog);
  for (const [name, text] of generated) {
    const path = join(output, name);
    if (process.argv.includes("--write")) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    } else if (readFileSync(path, "utf8") !== text)
      throw new Error(`CLI reference is stale: ${name}. Run bun run docs:reference.`);
  }
  console.log(
    `${catalog.length} command paths documented across ${[...generated.keys()].filter((name) => name.endsWith(".mdx")).length} reference pages.`,
  );
}
