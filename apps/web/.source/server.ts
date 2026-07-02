// @ts-nocheck
import * as __fd_glob_22 from "../content/docs/security/permissions.mdx?collection=docs"
import * as __fd_glob_21 from "../content/docs/security/isolation.mdx?collection=docs"
import * as __fd_glob_20 from "../content/docs/security/cloud-boundary.mdx?collection=docs"
import * as __fd_glob_19 from "../content/docs/security/auth.mdx?collection=docs"
import * as __fd_glob_18 from "../content/docs/architecture/runtime-model.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/architecture/overview.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/architecture/data-ownership.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/architecture/cloud-as-source.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/quickstart.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/installation.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/first-deployment.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/cli.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/api.mdx?collection=docs"
import { default as __fd_glob_8 } from "../content/docs/security/meta.json?collection=docs"
import { default as __fd_glob_7 } from "../content/docs/architecture/meta.json?collection=docs"
import { default as __fd_glob_6 } from "../content/docs/meta.json?collection=docs"
import * as __fd_glob_5 from "../content/resources/self-hosting-cost-breakdown.mdx?collection=resources"
import * as __fd_glob_4 from "../content/resources/introducing-openship.mdx?collection=resources"
import * as __fd_glob_3 from "../content/resources/how-ai-builds-work.mdx?collection=resources"
import * as __fd_glob_2 from "../content/changelog/v0-2-0.mdx?collection=changelog"
import * as __fd_glob_1 from "../content/changelog/v0-1-1.mdx?collection=changelog"
import * as __fd_glob_0 from "../content/changelog/v0-1-0.mdx?collection=changelog"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const changelog = await create.docs("changelog", "content/changelog", {}, {"v0-1-0.mdx": __fd_glob_0, "v0-1-1.mdx": __fd_glob_1, "v0-2-0.mdx": __fd_glob_2, });

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_6, "architecture/meta.json": __fd_glob_7, "security/meta.json": __fd_glob_8, }, {"api.mdx": __fd_glob_9, "cli.mdx": __fd_glob_10, "first-deployment.mdx": __fd_glob_11, "index.mdx": __fd_glob_12, "installation.mdx": __fd_glob_13, "quickstart.mdx": __fd_glob_14, "architecture/cloud-as-source.mdx": __fd_glob_15, "architecture/data-ownership.mdx": __fd_glob_16, "architecture/overview.mdx": __fd_glob_17, "architecture/runtime-model.mdx": __fd_glob_18, "security/auth.mdx": __fd_glob_19, "security/cloud-boundary.mdx": __fd_glob_20, "security/isolation.mdx": __fd_glob_21, "security/permissions.mdx": __fd_glob_22, });

export const resources = await create.docs("resources", "content/resources", {}, {"how-ai-builds-work.mdx": __fd_glob_3, "introducing-openship.mdx": __fd_glob_4, "self-hosting-cost-breakdown.mdx": __fd_glob_5, });