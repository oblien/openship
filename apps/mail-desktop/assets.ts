import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { outlineModern } from "@repo/ui/icons";

const dest = join(import.meta.dir, "dist");
mkdirSync(join(dest, "icons"), { recursive: true });
for (const font of ["Gellix-Regular.woff2", "Gellix-Medium.woff2"]) {
  copyFileSync(join(import.meta.dir, "../desktop/assets/fonts", font), join(dest, font));
}
copyFileSync(join(import.meta.dir, "../email/client/public/mail.svg"), join(dest, "mail.svg"));
copyFileSync(require.resolve("@repo/ui/desktop-titlebar.css"), join(dest, "titlebar.css"));
for (const name of [
  "chevron-left",
  "chevron-right",
  "more",
  "minus",
  "square",
  "copy",
  "close",
] as const) {
  const { file } = outlineModern[name];
  copyFileSync(join(import.meta.dir, "../dashboard/public/icons", file), join(dest, "icons", file));
}
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "launcher/titlebar.tsx")],
  outdir: dest,
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Could not build the Mail title bar");
