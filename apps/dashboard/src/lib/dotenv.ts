import { parseEnvFile, serializeEnvFile, unquoteEnvValue } from "@repo/core";

/** Import literal values; environment-editor imports never interpolate secrets. */
export function parseDotenv(
  content: string,
  options?: { strict?: boolean },
): Array<{ key: string; value: string }> {
  return parseEnvFile(content, options).map(({ key, value }) => ({ key, value }));
}

export const serializeDotenv = serializeEnvFile;

/** A row's value as a .env reader would see it: a surrounding pair of quotes is
 * a delimiter, not part of the value. */
export const normalizeDotenvValue = unquoteEnvValue;

/** Names referenced by `${NAME}` / `$NAME` in a saved value. */
export function envReferencesIn(value: string): string[] {
  const out = new Set<string>();
  let cursor = 0;
  while (cursor < value.length) {
    const dollar = value.indexOf("$", cursor);
    if (dollar < 0) break;
    if (value[dollar + 1] === "$") {
      cursor = dollar + 2;
      continue;
    }
    let name: string | undefined;
    let end = dollar + 1;
    if (value[dollar + 1] === "{") {
      const braced = value.slice(dollar + 2).match(/^([A-Za-z_][A-Za-z0-9_]*)\}/);
      if (braced) {
        name = braced[1]!;
        end = dollar + 2 + braced[0].length;
      }
    } else {
      const bare = value.slice(dollar + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (bare) {
        name = bare[1]!;
        end = dollar + 1 + bare[1]!.length;
      }
    }
    if (name) out.add(name);
    cursor = name ? end : dollar + 1;
  }
  return [...out];
}
