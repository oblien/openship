// Flatten the existing JSX illustrations once. Social crawlers receive local PNGs
// and the image renderer does not depend on browser CSS variables or React DOM.
import { writeFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { featureArtwork } from "../../../packages/ui/src/illustrations/artwork";
import {
  INK,
  ACCENT,
  ACCENT_INK,
  CUTOUT,
  SURFACE,
} from "../../../packages/ui/src/illustrations/palette";

const ink = "#292b29";
const illustrations = Object.fromEntries(
  Object.entries(featureArtwork).map(([name, draw]) => {
    const svg = renderToStaticMarkup(
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="400"
        height="320"
        viewBox="0 0 80 64"
        fill="none"
        stroke="none"
      >
        {draw("share")}
      </svg>,
    )
      .replaceAll(INK, ink)
      .replaceAll(ACCENT, "#bcaddf")
      .replaceAll(ACCENT_INK, ink)
      .replaceAll(CUTOUT, "#f8f8f5")
      .replaceAll(SURFACE, "#eeeee9");
    return [name, svg];
  }),
);
await writeFile(
  new URL("../.share-feature-art.json", import.meta.url),
  JSON.stringify(illustrations),
);
