import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import { InstallTabs } from "@/components/install-tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { DocsDetails } from "@/components/docs/details";
import { DocsScreenshot } from "@/components/docs/screenshot";
import { Callout, type CalloutType } from "fumadocs-ui/components/callout";
import { Cards } from "fumadocs-ui/components/card";
import type { ComponentProps } from "react";
import { Icon, type IconName } from "@repo/ui/icons";

const calloutIcons = {
  info: "info",
  warn: "warning",
  warning: "warning",
  error: "warning",
  success: "check-circle",
  idea: "info",
} satisfies Record<CalloutType, IconName>;

// Native Fumadocs MDX components (Cards, Callouts, code blocks with copy, etc.),
// plus our own components usable in .mdx without an explicit import. Tabs/Tab are
// registered globally (they aren't in defaultMdxComponents) so docs pages can use
// <Tabs>/<Tab> without an import line.
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    // Keep heading anchors in every panel so Fumadocs can open the tab for a shared hash.
    Tab: (props: ComponentProps<typeof Tab>) => <Tab forceMount {...props} />,
    Tabs: ({ className = "", ...props }: ComponentProps<typeof Tabs>) => (
      <Tabs {...props} className={`docs-tabs ${className}`} />
    ),
    Cards: ({ className = "", ...props }: ComponentProps<typeof Cards>) => (
      <Cards {...props} className={`docs-links ${className}`} />
    ),
    Callout: ({
      className = "",
      type = "info",
      icon,
      ...props
    }: ComponentProps<typeof Callout>) => (
      <Callout
        {...props}
        type={type}
        icon={icon === undefined ? <Icon name={calloutIcons[type]} size={20} /> : icon}
        className={`docs-callout ${className}`}
      />
    ),
    InstallTabs,
    Step,
    Steps,
    Details: DocsDetails,
    DocsScreenshot,
    ...components,
  };
}
