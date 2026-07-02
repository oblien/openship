// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  changelog: create.doc("changelog", {"v0-1-0.mdx": () => import("../content/changelog/v0-1-0.mdx?collection=changelog"), "v0-1-1.mdx": () => import("../content/changelog/v0-1-1.mdx?collection=changelog"), "v0-2-0.mdx": () => import("../content/changelog/v0-2-0.mdx?collection=changelog"), }),
  docs: create.doc("docs", {"api.mdx": () => import("../content/docs/api.mdx?collection=docs"), "cli.mdx": () => import("../content/docs/cli.mdx?collection=docs"), "first-deployment.mdx": () => import("../content/docs/first-deployment.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "installation.mdx": () => import("../content/docs/installation.mdx?collection=docs"), "quickstart.mdx": () => import("../content/docs/quickstart.mdx?collection=docs"), "architecture/cloud-as-source.mdx": () => import("../content/docs/architecture/cloud-as-source.mdx?collection=docs"), "architecture/data-ownership.mdx": () => import("../content/docs/architecture/data-ownership.mdx?collection=docs"), "architecture/overview.mdx": () => import("../content/docs/architecture/overview.mdx?collection=docs"), "architecture/runtime-model.mdx": () => import("../content/docs/architecture/runtime-model.mdx?collection=docs"), "security/auth.mdx": () => import("../content/docs/security/auth.mdx?collection=docs"), "security/cloud-boundary.mdx": () => import("../content/docs/security/cloud-boundary.mdx?collection=docs"), "security/isolation.mdx": () => import("../content/docs/security/isolation.mdx?collection=docs"), "security/permissions.mdx": () => import("../content/docs/security/permissions.mdx?collection=docs"), }),
  resources: create.doc("resources", {"how-ai-builds-work.mdx": () => import("../content/resources/how-ai-builds-work.mdx?collection=resources"), "introducing-openship.mdx": () => import("../content/resources/introducing-openship.mdx?collection=resources"), "self-hosting-cost-breakdown.mdx": () => import("../content/resources/self-hosting-cost-breakdown.mdx?collection=resources"), }),
};
export default browserCollections;