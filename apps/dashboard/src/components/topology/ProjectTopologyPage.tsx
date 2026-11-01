"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { TopologySkeleton } from "./TopologySkeleton";

const ProjectTopology = dynamic(() => import("./ProjectTopology"), {
  ssr: false,
  loading: () => <TopologySkeleton withHeader />,
});

export function ProjectTopologyPage(props: {
  environmentControl: ReactNode;
  onPendingChange: (pending: boolean) => void;
}) {
  // Keep the tab's height while its existing canvas expands over the page.
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ProjectTopology {...props} />
    </div>
  );
}
