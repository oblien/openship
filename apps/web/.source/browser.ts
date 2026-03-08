// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  blog: create.doc("blog", {"how-ai-builds-work.mdx": () => import("../content/blog/how-ai-builds-work.mdx?collection=blog"), "introducing-openship.mdx": () => import("../content/blog/introducing-openship.mdx?collection=blog"), "self-hosting-cost-breakdown.mdx": () => import("../content/blog/self-hosting-cost-breakdown.mdx?collection=blog"), }),
  docs: create.doc("docs", {"api.mdx": () => import("../content/docs/api.mdx?collection=docs"), "cli.mdx": () => import("../content/docs/cli.mdx?collection=docs"), "first-deployment.mdx": () => import("../content/docs/first-deployment.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "installation.mdx": () => import("../content/docs/installation.mdx?collection=docs"), "quickstart.mdx": () => import("../content/docs/quickstart.mdx?collection=docs"), }),
};
export default browserCollections;