// Run from the repository root with bun scripts/generate-share-previews.ts.
import { fileURLToPath } from "node:url";
import { renderOgImage } from "../apps/web/src/lib/og-image";
import { deployCard, referralCard } from "../apps/web/src/lib/share-cards";

process.chdir(fileURLToPath(new URL("../apps/web/", import.meta.url)));
for (const [name, card] of [
  ["home", undefined],
  ["deploy", deployCard],
  ["referrals", referralCard],
] as const) {
  await Bun.write(`public/og/${name}.png`, await (await renderOgImage(card)).arrayBuffer());
}
