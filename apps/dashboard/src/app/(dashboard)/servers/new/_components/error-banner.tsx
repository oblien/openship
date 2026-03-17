import { XCircle } from "lucide-react";

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 p-4 flex items-start gap-3">
      <XCircle className="size-5 text-red-500 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-medium text-foreground">Connection failed</p>
        <p className="text-xs text-muted-foreground mt-0.5">{message}</p>
      </div>
    </div>
  );
}
