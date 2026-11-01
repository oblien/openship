import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCatalog } from "../packages/core/scripts/gen-catalog";
import { LOCAL_SERVICE_CATALOG } from "../apps/dashboard/src/app/(dashboard)/projects/[id]/components/services/local-service-catalog";

const run = promisify(execFile);

/** Registry dependencies of an inline build, including external COPY stages.
 * Stage names/numbers and scratch refer to the build itself, not a registry. */
export function catalogBuildImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const images = new Set<string>();
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    const copy = /^\s*COPY\s+--from=(\S+)/i.exec(line);
    const source = from?.[1] ?? copy?.[1];
    if (
      source &&
      source !== "scratch" &&
      !/^\d+$/.test(source) &&
      !stages.has(source.toLowerCase()) &&
      !source.includes("$")
    )
      images.add(source);
    if (from?.[2]) stages.add(from[2].toLowerCase());
  }
  return [...images];
}

export function catalogImages(
  apps: readonly {
    id: string;
    available?: boolean;
    services?: readonly { name: string; image?: string; build?: { dockerfile: string } }[];
  }[],
  library: Array<{ id?: string; image?: string }> = [],
): Map<string, string[]> {
  const images = new Map<string, string[]>();
  const add = (image: string | undefined, source: string) => {
    if (!image) return;
    images.set(image, [...(images.get(image) ?? []), source]);
  };
  for (const app of apps) {
    if (!app.available) continue;
    for (const service of app.services ?? []) {
      const source = app.id + "/" + service.name;
      add(service.image, source);
      for (const image of service.build ? catalogBuildImages(service.build.dockerfile) : [])
        add(image, source + "/build");
    }
  }
  for (const entry of library) add(entry.image, "library/" + entry.id);
  return images;
}

export async function checkCatalogImages(
  images: Map<string, string[]>,
  inspect: (image: string) => Promise<void> = async (image) => {
    // Docker owns registry authentication and image parsing. Do not introduce
    // another Registry v2 client just for CI. No daemon or image layers needed.
    const { stdout } = await run("docker", ["buildx", "imagetools", "inspect", "--raw", image], {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const manifest = JSON.parse(stdout);
    if (
      manifest.schemaVersion !== 2 ||
      (!Array.isArray(manifest.manifests) && !Array.isArray(manifest.layers))
    )
      throw new Error("Registry did not return an OCI/Docker manifest");
  },
): Promise<Array<{ image: string; sources: string[] }>> {
  const queue = [...images];
  const failures: Array<{ image: string; sources: string[] }> = [];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) break;
        const [image, sources] = item;
        try {
          await inspect(image);
        } catch {
          failures.push({ image, sources });
        }
      }
    }),
  );
  return failures.sort((a, b) => a.image.localeCompare(b.image));
}

if (import.meta.main) {
  try {
    await run("docker", ["buildx", "version"]);
  } catch {
    console.error(
      "Catalog checks require Docker Buildx. Install it before checking image availability.",
    );
    process.exit(1);
  }
  const images = catalogImages(buildCatalog().apps, LOCAL_SERVICE_CATALOG);
  const failures = await checkCatalogImages(images);
  console.log(JSON.stringify({ checked: images.size, failures }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
