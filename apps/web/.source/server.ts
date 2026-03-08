// @ts-nocheck
import * as __fd_glob_9 from "../content/docs/quickstart.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/installation.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/first-deployment.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/cli.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/api.mdx?collection=docs"
import { default as __fd_glob_3 } from "../content/docs/_meta.json?collection=docs"
import * as __fd_glob_2 from "../content/blog/self-hosting-cost-breakdown.mdx?collection=blog"
import * as __fd_glob_1 from "../content/blog/introducing-openship.mdx?collection=blog"
import * as __fd_glob_0 from "../content/blog/how-ai-builds-work.mdx?collection=blog"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const blog = await create.docs("blog", "content/blog", {}, {"how-ai-builds-work.mdx": __fd_glob_0, "introducing-openship.mdx": __fd_glob_1, "self-hosting-cost-breakdown.mdx": __fd_glob_2, });

export const docs = await create.docs("docs", "content/docs", {"_meta.json": __fd_glob_3, }, {"api.mdx": __fd_glob_4, "cli.mdx": __fd_glob_5, "first-deployment.mdx": __fd_glob_6, "index.mdx": __fd_glob_7, "installation.mdx": __fd_glob_8, "quickstart.mdx": __fd_glob_9, });