import { Icon as UiIcon } from "@repo/ui/icons";

export function ScaleLoading() {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center text-muted-foreground"
      role="status"
    >
      <div className="flex flex-col items-center gap-3">
        <UiIcon name="network" className="size-7" />
        <span className="text-sm">Preparing your scaling workspace…</span>
      </div>
    </div>
  );
}
