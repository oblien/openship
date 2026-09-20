import { parseEnvFile, serializeEnvFile } from "@repo/core";

/** Import literal values; environment-editor imports never interpolate secrets. */
export function parseDotenv(content: string): Array<{ key: string; value: string }> {
  return parseEnvFile(content).map(({ key, value }) => ({ key, value }));
}

export const serializeDotenv = serializeEnvFile;
