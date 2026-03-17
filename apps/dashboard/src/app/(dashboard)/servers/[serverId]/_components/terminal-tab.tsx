import { Terminal, SquareTerminal } from "lucide-react";

export function TerminalTab() {
  return (
    <div className="space-y-6">
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div className="w-9 h-9 bg-zinc-500/10 rounded-xl flex items-center justify-center">
            <Terminal className="size-[18px] text-zinc-500" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]">
              Terminal
            </h2>
            <p className="text-xs text-muted-foreground">
              SSH shell access
            </p>
          </div>
        </div>
        <div className="p-8 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
            <SquareTerminal className="size-8 text-muted-foreground/50" />
          </div>
          <h3 className="text-sm font-medium text-foreground mb-1">
            SSH Terminal
          </h3>
          <p className="text-xs text-muted-foreground max-w-xs">
            Web-based terminal access to your server will be available here.
            Connect directly via SSH from the browser.
          </p>
          <div className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-muted/50 text-muted-foreground">
            Coming soon
          </div>
        </div>
      </div>
    </div>
  );
}
