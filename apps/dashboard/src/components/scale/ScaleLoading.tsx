import { Network } from "lucide-react";

export function ScaleLoading() {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center text-muted-foreground"
      role="status"
    >
      <div className="flex flex-col items-center gap-3">
        <Network className="size-7" strokeWidth={1.5} />
        <span className="text-sm">Preparing your scaling workspace…</span>
      </div>
    </div>
  );
}
