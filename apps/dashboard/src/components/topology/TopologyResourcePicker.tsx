"use client";

import { Icon, type IconName } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";

type ResourceKind = "service" | "database" | "volume";

export function TopologyResourcePicker({
  clusterTarget,
  onSelect,
  onClose,
}: {
  clusterTarget: boolean;
  onSelect: (kind: ResourceKind) => void;
  onClose: () => void;
}) {
  const options: { kind: ResourceKind; title: string; description: string; icon: IconName }[] = [
    ...(!clusterTarget
      ? [
          {
            kind: "service" as const,
            title: "Service",
            description: "Deploy an app, worker or service on this project's server.",
            icon: "server" as const,
          },
        ]
      : []),
    {
      kind: "database",
      title: "Database",
      description: "PostgreSQL or Redis on a cluster, with replication and backups.",
      icon: "database",
    },
    ...(clusterTarget
      ? [
          {
            kind: "volume" as const,
            title: "Shared files",
            description: "A shared folder for every application instance.",
            icon: "hard-drive" as const,
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted/50 text-muted-foreground">
          <Icon name="plus" className="size-4" />
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">Add resource</h2>
        <Button variant="ghost" size="icon" aria-label="Close add resource" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Choose what to add to this project.
        </p>
        <div className="space-y-2">
          {options.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="flex w-full items-start gap-3 rounded-xl bg-muted/30 p-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => onSelect(item.kind)}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground">
                <Icon name={item.icon} className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                </span>
              </span>
              <Icon
                name="chevron-right"
                className="size-4 shrink-0 self-center text-muted-foreground rtl:rotate-180"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
