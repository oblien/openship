import { Loader2 } from "lucide-react";

export function CheckingState() {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-8">
      <div className="flex flex-col items-center justify-center py-8">
        <Loader2 className="size-8 text-primary animate-spin mb-4" />
        <p className="text-sm font-medium text-foreground">Connecting to server&#8230;</p>
        <p className="text-xs text-muted-foreground mt-1">
          Running system health checks via SSH
        </p>
      </div>
    </div>
  );
}
