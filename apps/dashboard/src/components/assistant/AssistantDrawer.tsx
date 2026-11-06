"use client";

import { useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { Drawer } from "@/components/ui/Drawer";
import { AssistantNavigationContext } from "./AssistantLink";
import {
  assistantDrawerHref,
  assistantDrawerViews,
  closeAssistantDrawerHref,
  type AssistantDrawerView,
} from "./assistant-navigation";
import { AssistantAgents } from "./AssistantAgents";
import { AgentEditor } from "./AgentEditor";
import { AutomationEditorPanel } from "./AutomationEditorData";

export function AssistantDrawerLayout({ children }: { children: ReactNode }) {
  const scope = useResourceScope();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [revision, setRevision] = useState(0);
  const href = (destination: string) => assistantDrawerHref(destination, pathname, search);
  const close = () => router.replace(closeAssistantDrawerHref(pathname, search), { scroll: false });
  const changed = () => setRevision((value) => value + 1);
  return (
    <AssistantNavigationContext.Provider
      value={{
        href,
        navigate: (destination) => router.replace(href(destination), { scroll: false }),
        close,
        changed,
        revision,
        open: assistantDrawerViews(search).length > 0,
      }}
    >
      {children}
      <AssistantPanel key={scope} search={search} onClose={close} onChanged={changed} />
    </AssistantNavigationContext.Provider>
  );
}

function viewKey(view: AssistantDrawerView) {
  return view.kind === "agent"
    ? `agent:${view.id ?? "list"}:${view.editing}:${view.template ?? ""}:${view.project ?? ""}`
    : `automation:${view.id ?? "new"}:${view.trigger}:${view.agentId ?? ""}`;
}

function AssistantPanel({
  search,
  onClose,
  onChanged,
}: {
  search: string;
  onClose(): void;
  onChanged(): void;
}) {
  const current = assistantDrawerViews(search);
  // Retain the outgoing content only for the close animation.
  const [retained, setRetained] = useState(search);
  if (current.length && retained !== search) setRetained(search);
  const views = current.length ? current : assistantDrawerViews(retained);
  const view = views.at(-1);
  const automation = view?.kind === "automation";
  return (
    <Drawer
      isOpen={current.length > 0}
      closeLabel={automation ? "Close automation" : "Close agents"}
      contentKey={view ? viewKey(view) : undefined}
      onClose={onClose}
      label={
        automation
          ? view.id
            ? "Edit automation"
            : "Create automation"
          : view?.editing
            ? view.id
              ? "Edit agent"
              : "Create agent"
            : "Agents"
      }
      width={automation ? "880px" : view?.editing ? "100%" : view?.id ? "620px" : "560px"}
    >
      {views.map((item) => (
        <div
          key={viewKey(item)}
          hidden={item !== view}
          className={item === view ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          {item.kind === "automation" ? (
            <AutomationEditorPanel
              {...item}
              onCancel={onClose}
              onSaved={() => {
                onChanged();
                onClose();
              }}
            />
          ) : item.editing ? (
            <AgentEditor {...item} />
          ) : (
            <AssistantAgents id={item.id} />
          )}
        </div>
      ))}
    </Drawer>
  );
}
