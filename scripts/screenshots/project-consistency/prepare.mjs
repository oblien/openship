import { cp, mkdir, readFile, writeFile, readdir, unlink, symlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, "../../..");
const app = resolve(root, "artifacts/project-consistency/preview-app");
await mkdir(app, { recursive: true });
await cp(resolve(root, "apps/dashboard/src"), resolve(app, "src"), {
  recursive: true,
  filter: (path) => !path.includes(".test."),
});
// The preview runs a copied dashboard with only fixture routes. It cannot reach
// the main dashboard's route handlers or mutate its files.
async function stripRoutes(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) await stripRoutes(path);
    else if (
      /^(page|layout|route|not-found|global-not-found)\.(tsx?|jsx?)$/.test(item.name) &&
      path !== resolve(app, "src/app/layout.tsx")
    )
      await unlink(path);
  }
}
await stripRoutes(resolve(app, "src/app"));
await unlink(resolve(app, "src/proxy.ts")).catch(() => {});
for (const [target, path] of [
  [resolve(root, "node_modules"), resolve(app, "node_modules")],
  [resolve(root, "apps/dashboard/public"), resolve(app, "public")],
]) {
  await symlink(target, path).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
}
await cp(resolve(root, "apps/dashboard/postcss.config.mjs"), resolve(app, "postcss.config.mjs"));
await writeFile(
  resolve(app, "package.json"),
  JSON.stringify({ name: "openship-consistency-preview", private: true, type: "module" }),
);
await writeFile(
  resolve(app, "tsconfig.json"),
  JSON.stringify({
    extends: "../../../tsconfig.base.json",
    compilerOptions: {
      jsx: "preserve",
      noEmit: true,
      baseUrl: ".",
      paths: { "@/*": ["./src/*"] },
      plugins: [{ name: "next" }],
    },
    include: ["src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
  }),
);
await writeFile(
  resolve(app, "next.config.mjs"),
  `export default { transpilePackages: ['@repo/ui','@repo/core','@repo/db'], outputFileTracingRoot: ${JSON.stringify(root)}, devIndicators: false, turbopack: { root: ${JSON.stringify(root)} } };`,
);
const css = resolve(app, "src/app/globals.css");
await writeFile(
  css,
  (await readFile(css, "utf8")).replace(
    "../../../../packages/ui/src/AppLogo.tsx",
    resolve(root, "packages/ui/src/AppLogo.tsx"),
  ),
);
const route = resolve(app, "src/app/projects/[id]/[[...slug]]");
await mkdir(route, { recursive: true });
await cp(resolve(here, "Preview.tsx"), resolve(route, "Preview.tsx"));
await writeFile(
  resolve(route, "page.tsx"),
  'import Preview from "./Preview"; export default Preview;',
);
const build = resolve(app, "src/app/build/[id]");
await mkdir(build, { recursive: true });
await writeFile(
  resolve(build, "page.tsx"),
  'import Link from "next/link"; export default function Page(){return <main className="mx-auto max-w-3xl p-10 space-y-5"><h1 className="text-xl">Environment update queued</h1><p>Preview only. Your saved values remain in the fixture; no real deployment was started.</p><Link href="/projects/environment-preview/services/application/env">Return to website environment →</Link></main>;}',
);
console.log(app);
