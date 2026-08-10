/**
 * Comment strippers for the hand-rolled workspace manifest readers.
 *
 * Two of the manifests we read allow comments that a strict parser does not:
 * `rush.json` is JSONC, and `pom.xml` is XML. Removing them before matching
 * keeps a commented-out entry from being read as a live one - the same rule the
 * TOML (`#`), Gradle (`//`, block) and go.work (`//`) readers already follow.
 */

/**
 * Remove `//` line and block comments from JSON-with-comments.
 *
 * String-aware: a `//` inside a JSON string stays put, so the `$schema` URL
 * every `rush.json` carries survives.
 */
export function stripJsonComments(content: string): string {
  let out = "";
  let inString = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += content[++i] ?? "";
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && content[i + 1] === "/") {
      const newline = content.indexOf("\n", i);
      if (newline === -1) break;
      i = newline - 1; // the newline itself is copied on the next iteration
      continue;
    }

    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    out += ch;
  }

  return out;
}

/** Remove `<!-- … -->` comments. XML comments never nest, so the lazy match is exact. */
export function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}
