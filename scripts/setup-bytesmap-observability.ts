import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  bytesmapOperationalDimensions,
  bytesmapOperationalQueries,
  bytesmapOperationalView,
} from "./bytesmap-observability-model";

type Configuration = {
  apiUrl: string;
  organizationId: string;
  datasetId: string;
  manifestPath: string;
};
type Manifest = {
  organizationId: string;
  datasetId: string;
  queries: string[];
  views: string[];
  dashboardId?: string;
  workspaceId?: string;
  publicationId?: string;
};

/** Operator-run setup only. It never buys storage, deploys software, or handles an ingestion key. */
export async function setupBytesMapObservability(config: Configuration, apply: boolean) {
  const api = new URL(config.apiUrl);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    api.protocol !== "https:" ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash ||
    !uuid.test(config.datasetId) ||
    !config.organizationId ||
    !config.manifestPath
  )
    throw new Error(
      "Provide a BytesMap HTTPS API origin, organization ID, existing dataset UUID and private manifest path.",
    );
  const tokenPath = process.env.BYTESMAP_API_TOKEN_FILE;
  if (!tokenPath)
    throw new Error(
      "Set BYTESMAP_API_TOKEN_FILE to a private JSON file containing the operator API token.",
    );
  const { token } = JSON.parse(await readFile(tokenPath, "utf8"));
  if (typeof token !== "string" || !token) throw new Error("Operator API token is unavailable.");
  let projectId: string | undefined;
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(new URL(`/api/${path}`, api), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-organization-id": config.organizationId,
        "content-type": "application/json",
        ...(projectId ? { "x-bytesmap-project": projectId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `BytesMap ${method} ${path} failed (${response.status}); no credentials or response payload are printed.`,
      );
    const result = (await response.json()) as any;
    return result.data ?? result;
  }
  const identity = await request("me");
  if (identity.organizationId !== config.organizationId)
    throw new Error("The authenticated BytesMap organization does not match configuration.");
  let dataset = await request(`events/datasets/${config.datasetId}`);
  if (dataset.id !== config.datasetId)
    throw new Error("The returned BytesMap dataset does not match configuration.");
  projectId = dataset.projectId ?? undefined;
  const fields = new Map<string, { name: string; type: string }>(
    dataset.dimensions.map((field: { name: string; type: string }) => [field.name, field]),
  );
  const missing = bytesmapOperationalDimensions.filter((field) => !fields.has(field.name));
  for (const field of bytesmapOperationalDimensions) {
    if (fields.has(field.name) && fields.get(field.name)!.type !== field.type)
      throw new Error(`Incompatible existing dataset dimension: ${field.name}`);
  }
  if (fields.size + missing.length > 64)
    throw new Error(
      "Use a dedicated operations dataset; these fields would exceed its 64-dimension limit.",
    );
  const panels = bytesmapOperationalQueries(dataset.tableName);
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          mode: "preview",
          datasetId: dataset.id,
          addDimensions: missing,
          panels: panels.map((panel) => panel.title),
        },
        null,
        2,
      ),
    );
    return;
  }
  const manifestPath = resolve(config.manifestPath);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifest = {
      organizationId: config.organizationId,
      datasetId: dataset.id,
      queries: [],
      views: [],
    };
    await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  }
  if (
    manifest.organizationId !== config.organizationId ||
    manifest.datasetId !== dataset.id ||
    !Array.isArray(manifest.queries) ||
    !Array.isArray(manifest.views)
  )
    throw new Error("The setup manifest belongs to a different dataset or is invalid.");
  const save = async () => {
    const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, manifestPath);
  };
  if (missing.length)
    dataset = await request(`events/datasets/${dataset.id}`, "PATCH", {
      version: dataset.version,
      dimensions: [...fields.values(), ...missing],
    });
  for (const [index, panel] of panels.entries()) {
    if (!manifest.queries[index]) {
      const result = await request("queries", "POST", {
        name: `OpenShip Cloud · ${panel.title}`,
        sourceId: dataset.sourceId,
        query: { kind: "native", sourceKind: "clickhouse", statement: panel.statement },
      });
      manifest.queries[index] = result.query.id;
      await save();
    }
    if (!manifest.views[index]) {
      const result = await request("views", "POST", {
        definition: bytesmapOperationalView(panel, manifest.queries[index]!),
      });
      manifest.views[index] = result.view.id;
      await save();
    }
  }
  if (!manifest.dashboardId) {
    const result = await request("dashboards", "POST", {
      title: "OpenShip Cloud · Operations",
      layout: manifest.views.map((app) => ({ app, w: 12, h: 6 })),
    });
    manifest.dashboardId = result.dashboard.id;
    await save();
  }
  if (!manifest.publicationId) {
    const { workspace } = await request(`dashboards/${manifest.dashboardId}/runtime`);
    const published = await request(`workspaces/${workspace.id}/publish`, "POST", {
      version: workspace.version,
    });
    manifest.workspaceId = published.workspace.id;
    manifest.publicationId = published.workspace.publicationId;
    await save();
  }
  console.log(
    JSON.stringify(
      {
        datasetId: dataset.id,
        dashboardId: manifest.dashboardId,
        workspaceId: manifest.workspaceId,
        publicationId: manifest.publicationId,
        manifestPath,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  const [configPath, ...flags] = process.argv.slice(2);
  if (configPath === "--schema")
    console.log(JSON.stringify(bytesmapOperationalDimensions, null, 2));
  else {
    if (!configPath || flags.some((flag) => flag !== "--apply"))
      throw new Error(
        "Usage: bun scripts/setup-bytesmap-observability.ts <configuration.json> [--apply], or --schema",
      );
    await setupBytesMapObservability(
      JSON.parse(await readFile(configPath, "utf8")),
      flags.includes("--apply"),
    );
  }
}
