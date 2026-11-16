/** nginx and its Lua block reader bound individual tokens. Chunk encoded data
 * rather than interpolating HTML or allowing a large file to break a reload. */
export function encodeConfigData(value: unknown): string[] {
  return (
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .match(/.{1,2048}/g) ?? []
  );
}

export function luaConfigData(value: unknown): string {
  const chunks = encodeConfigData(value);
  return chunks.length === 1
    ? `'${chunks[0]}'`
    : `table.concat({\n${chunks.map((chunk) => `    '${chunk}',`).join("\n")}\n})`;
}
