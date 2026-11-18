import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function localMark(
  directory: string,
  files: Promise<string[]>,
  name: string,
  keys: string[],
) {
  const available = await files;
  const file = keys
    .flatMap((key) => [key + ".svg", key + ".png"])
    .find((key) => available.includes(key));
  if (!file) return { name };
  const mime = file.endsWith(".svg") ? "svg+xml" : "png";
  return {
    name,
    src: `data:image/${mime};base64,${await readFile(join(directory, file), "base64")}`,
  };
}

let appFiles: Promise<string[]> | undefined;
export async function appMark(name: string, id: string, logo: string) {
  const directory = join(process.cwd(), "public/app-logos");
  appFiles ??= readdir(directory);
  if (id === "mail")
    return {
      name,
      src: `data:image/png;base64,${await readFile(join(process.cwd(), "public/apple-touch-icon.png"), "base64")}`,
    };
  return localMark(directory, appFiles, name, [logo, id]);
}

let providerFiles: Promise<string[]> | undefined;
export async function providerMark(slug: string, name: string) {
  const directory = join(process.cwd(), "public/provider-logos");
  providerFiles ??= readdir(directory);
  return localMark(directory, providerFiles, name, [slug]);
}
