"use client";

import { useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { Drawer } from "@/components/ui/Drawer";
import { AgentNavigationContext } from "./AgentLink";
import { agentDrawerHref, agentDrawerView, closeAgentDrawerHref } from "./agent-navigation";
import { AssistantAgents } from "./AssistantAgents";
import { AgentEditor } from "./AgentEditor";

export function AgentDrawerLayout({ children }: { children: ReactNode }) {
  const scope = useResourceScope();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [revision, setRevision] = useState(0);
  const href = (destination: string) => agentDrawerHref(destination, pathname, search);
  const close = () => router.replace(closeAgentDrawerHref(pathname, search), { scroll: false });
  return (
    <AgentNavigationContext.Provider
      value={{
        href,
        navigate: (destination) => router.replace(href(destination), { scroll: false }),
        close,
        changed: () => setRevision((value) => value + 1),
        revision,
        open: !!agentDrawerView(search),
      }}
    >
      {children}
      <AgentPanel key={scope} search={search} onClose={close} />
    </AgentNavigationContext.Provider>
  );
}

function AgentPanel({ search, onClose }: { search: string; onClose(): void }) {
  const current = agentDrawerView(search);
  // Retain the outgoing content only for the close animation.
  const [retained, setRetained] = useState(search);
  if (current && retained !== search) setRetained(search);
  const view = current ?? agentDrawerView(retained);
  return (
    <Drawer
      isOpen={!!current}
      closeLabel="Close agents"
      contentKey={
        view
          ? `${view.id ?? "list"}:${view.editing}:${view.template ?? ""}:${view.project ?? ""}`
          : undefined
      }
      onClose={onClose}
      label={view?.editing ? (view.id ? "Edit agent" : "Create agent") : "Agents"}
      width={view?.editing ? "100%" : view?.id ? "620px" : "560px"}
    >
      {view &&
        (view.editing ? (
          <AgentEditor
            key={`${view.id ?? "new"}:${view.template ?? ""}:${view.project ?? ""}`}
            {...view}
          />
        ) : (
          <AssistantAgents key={view.id ?? "list"} id={view.id} />
        ))}
    </Drawer>
  );
}
