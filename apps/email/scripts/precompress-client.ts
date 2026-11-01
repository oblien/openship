import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// Run after React Router finalizes the SPA manifest and CSS.
const directory = resolve(process.argv[2] ?? `${import.meta.dir}/../client/build/client/assets`);
for (const name of await readdir(directory, { recursive: true })) {
  if (!/\.(js|css)$/.test(name)) continue;
  const path = resolve(directory, name);
  const bytes = await readFile(path);
  if (bytes.length < 1024) continue;
  await writeFile(
    `${path}.br`,
    brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }),
  );
  await writeFile(`${path}.gz`, gzipSync(bytes));
}
