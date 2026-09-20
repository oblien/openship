"use client";

import dynamic from "next/dynamic";
import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";

const ProjectTopology = dynamic(() => import("./ProjectTopology"), {
  ssr: false,
  loading: () => (
    <div
      className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <GitBranch className="size-5" />
      Loading project topology…
    </div>
  ),
});

export function ProjectTopologyPage(props: {
  environmentControl: ReactNode;
  onPendingChange: (pending: boolean) => void;
}) {
  return <ProjectTopology {...props} />;
}
