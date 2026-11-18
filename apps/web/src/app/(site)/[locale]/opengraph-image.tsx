import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OG_SIZE, OG_ALT } from "@/lib/og-image";

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OgImage() {
  const image = await readFile(join(process.cwd(), "public/og/home.png"));
  return new Response(new Uint8Array(image), { headers: { "Content-Type": contentType } });
}
