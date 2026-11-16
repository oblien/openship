import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import { InstallTabs } from "@/components/install-tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { DocsDetails } from "@/components/docs/details";

// Native Fumadocs MDX components (Cards, Callouts, code blocks with copy, etc.),
// plus our own components usable in .mdx without an explicit import. Tabs/Tab are
// registered globally (they aren't in defaultMdxComponents) so docs pages can use
// <Tabs>/<Tab> without an import line.
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Tab,
    Tabs,
    InstallTabs,
    Step,
    Steps,
    Details: DocsDetails,
    ...components,
  };
}
