import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { ReactNode } from "react";

export function MailPanels({
  mailList,
  readingPane,
  hasThread,
}: {
  mailList: ReactNode;
  readingPane: ReactNode;
  hasThread: boolean;
}) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const isSplit = useMediaQuery("(min-width: 1024px)");

  return (
    <ResizablePanelGroup
      key={isSplit ? "split" : "single"}
      direction="horizontal"
      autoSaveId={isSplit ? "mail-split-panel-layout" : undefined}
      className="rounded-inherit overflow-hidden"
    >
      {(isSplit || !isDesktop || !hasThread) && (
        <ResizablePanel
          id="mail-list"
          order={1}
          defaultSize={isSplit ? 35 : 100}
          minSize={isSplit ? 20 : 100}
          maxSize={isSplit ? 60 : 100}
          className="bg-panelLight dark:bg-panelDark mb-1 shadow-sm md:rounded-2xl lg:h-[calc(100dvh-8px)]"
        >
          {mailList}
        </ResizablePanel>
      )}

      {isSplit && (
        <ResizableHandle
          withHandle
          aria-label="Resize email list and reading pane"
          aria-orientation="vertical"
          title="Drag to resize, or use the arrow keys"
          className="hover:bg-border focus-visible:bg-border w-1 bg-transparent"
        />
      )}

      {isDesktop && (isSplit || hasThread) && (
        <ResizablePanel
          id="mail-reader"
          order={2}
          defaultSize={isSplit ? 65 : 100}
          minSize={isSplit ? 40 : 100}
          className="bg-panelLight dark:bg-panelDark mb-1 mr-0.5 rounded-2xl shadow-sm lg:h-[calc(100dvh-8px)]"
        >
          <div className="relative flex-1">{readingPane}</div>
        </ResizablePanel>
      )}

      {!isDesktop && hasThread && (
        <div className="bg-panelLight dark:bg-panelDark fixed inset-0 z-50">
          <div className="flex h-full flex-col">
            <div className="h-full overflow-y-auto outline-none">{readingPane}</div>
          </div>
        </div>
      )}
    </ResizablePanelGroup>
  );
}
