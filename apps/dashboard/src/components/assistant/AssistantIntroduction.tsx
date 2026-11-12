import Link from "next/link";
import { Icon, IconArtwork } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import type { ReactNode } from "react";
import { AssistantIntroductionPreview } from "./AssistantIntroductionPreview";

export function AssistantIntroduction({ children }: { children: ReactNode }) {
  return (
    <div className="@container/assistant-introduction">
      <section
        aria-labelledby="assistant-introduction-title"
        className="grid grid-cols-1 items-start gap-6 pb-6 @min-[60rem]/assistant-introduction:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div className="min-w-0 rounded-2xl bg-card px-6 py-8 text-center">
          <FeatureIllustration
            name="ai-mcp"
            className="illustration-color mx-auto mb-4 h-16 w-20"
          />
          <h2
            id="assistant-introduction-title"
            className="text-xl font-medium tracking-tight text-foreground"
          >
            Put your agents to work.
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Connect an agent and start a conversation about your apps, repositories, or servers.
          </p>
        </div>
        <aside
          aria-labelledby="assistant-setup-title"
          className="min-w-0 space-y-4 @min-[60rem]/assistant-introduction:col-start-2 @min-[60rem]/assistant-introduction:row-span-2 @min-[60rem]/assistant-introduction:row-start-1"
        >
          <div className="rounded-2xl bg-card p-5">
            <div aria-hidden="true" className="flex items-center gap-5 text-foreground">
              <Icon name="codex" className="size-7" />
              <Icon name="claude" className="size-7" />
              <IconArtwork src="/provider-logos/antigravity.svg" mode="color" className="size-7" />
              <IconArtwork src="/provider-logos/grok.svg" mode="mask" className="size-7" />
            </div>
            <h3 id="assistant-setup-title" className="mt-5 text-base font-medium text-foreground">
              Build with your agent
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Use Codex or Claude Code in OpenShip, or Grok through a custom API.
            </p>
            <div className="mt-6">{children}</div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Connect Antigravity and other tools through{" "}
            <Link
              href="/settings?tab=mcp"
              className="inline-flex items-center gap-1 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              MCP setup
              <Icon name="arrow-up-right" className="size-3" />
            </Link>
            .
          </p>
        </aside>
        <AssistantIntroductionPreview />
      </section>
    </div>
  );
}
