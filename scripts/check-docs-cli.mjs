import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { docsDirectory, filesUnder, root } from "./docs-surface.mjs";

// Tokenize documented shell commands without invoking the shell or command actions.
function tokens(line) {
  const result = [];
  let token = "",
    quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && quote !== "'" && i + 1 < line.length) {
      token += line[++i];
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && !token) break;
    if (/\s/.test(char)) {
      if (token) result.push(token);
      token = "";
    } else token += char;
  }
  if (token) result.push(token);
  return result;
}

function flags(entry) {
  return new Map(
    entry.options.flatMap((option) => {
      const names =
        option.syntax
          .match(/(?:^|[, ])(--?[\w-]+)/g)
          ?.map((name) => name.trim().replace(/^,\s*/, "")) ?? [];
      return names.map((name) => [
        name,
        { value: /[<[]/.test(option.syntax), optional: option.syntax.includes("[") },
      ]);
    }),
  );
}

export function checkCliExamples(catalog) {
  const entries = new Map(catalog.map((entry) => [entry.command, entry]));
  const globalFlags = flags(entries.get("openship"));
  const errors = [];
  let count = 0;
  for (const file of filesUnder(docsDirectory, ".mdx")) {
    if (file.includes("/cli/reference/")) continue;
    const source = readFileSync(file, "utf8");
    for (const block of source.matchAll(/^```(?:bash|sh|shell)\b[^\n]*\n([\s\S]*?)^```/gm)) {
      for (const line of block[1].replace(/\\\n\s*/g, " ").split("\n")) {
        const command = line.trim().replace(/^npx\s+/, "");
        if (!command.startsWith("openship ")) continue;
        const parts = tokens(command).slice(1);
        let entry = entries.get("openship");
        count++;
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          if (["--", "|", "||", "&&", ";", ">", ">>"].includes(part)) break;
          if (part.startsWith("-")) {
            const [name] = part.split("=", 1);
            const option = flags(entry).get(name) ?? globalFlags.get(name);
            if (!option)
              errors.push(`${relative(root, file)}: ${entry.command} has no ${name} option`);
            else if (
              option.value &&
              !part.includes("=") &&
              (!option.optional || !parts[index + 1]?.startsWith("-"))
            )
              index++;
            continue;
          }
          const child = entry.children.find((row) =>
            row.syntax.split(" ")[0].split("|").includes(part),
          );
          if (child) entry = entries.get(entry.command + " " + child.syntax.split(/[ |]/)[0]);
          else if (entry.children.length && !entry.arguments.length)
            errors.push(`${relative(root, file)}: ${entry.command} has no ${part} subcommand`);
        }
      }
    }
  }
  if (errors.length) throw new Error([...new Set(errors)].join("\n"));
  return count;
}
