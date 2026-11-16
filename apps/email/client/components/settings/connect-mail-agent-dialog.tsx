import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/providers/query-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getBackendUrl } from "@/lib/backend-url";

const permissions = [
  {
    scope: "mail:read",
    label: "Read and search",
    description: "Find messages and read their contents.",
  },
  {
    scope: "mail:draft",
    label: "Save drafts",
    description: "Create and edit drafts in your mailbox.",
  },
  { scope: "mail:send", label: "Prepare sends", description: "Every message needs your approval." },
] as const;
type Scope = (typeof permissions)[number]["scope"];

export function ConnectMailAgentDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const trpc = useTRPC();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["mail:read", "mail:draft"]);
  const create = useMutation(trpc.mailAgents.create.mutationOptions({ onSuccess: onConnected }));
  const token = create.data?.token;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy. Select and copy the text.");
    }
  };
  const close = (value: boolean) => {
    if (create.isPending) return;
    create.reset();
    setName("");
    setScopes(["mail:read", "mail:draft"]);
    onOpenChange(value);
  };
  const url = `${getBackendUrl()}/mcp`;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showOverlay
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl p-5 sm:p-6"
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-base font-medium">
            {token ? "Your connection is ready" : "Connect an agent"}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {token
              ? "Copy these into your agent’s MCP settings."
              : "Choose what this agent can do in your mailbox."}
          </DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close agent connection"
            disabled={create.isPending}
            className="absolute right-3 top-3 size-8"
          >
            <X />
          </Button>
        </DialogClose>
        {token ? (
          <div className="mt-5 space-y-4">
            <label className="block space-y-2 text-[13px]">
              <span>Server URL</span>
              <div className="flex gap-2">
                <Input readOnly value={url} />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy server URL"
                  onClick={() => void copy(url)}
                >
                  <Copy />
                </Button>
              </div>
            </label>
            <label className="block space-y-2 text-[13px]">
              <span>Authorization header</span>
              <div className="flex gap-2">
                <Input readOnly type="password" value={`Bearer ${token}`} autoComplete="off" />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy authorization header"
                  onClick={() => void copy(`Bearer ${token}`)}
                >
                  <Copy />
                </Button>
              </div>
            </label>
            <p className="text-muted-foreground text-xs leading-relaxed">
              This token is shown once and expires in 30 days. You can revoke it here anytime.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void copy(
                    JSON.stringify(
                      {
                        mcpServers: {
                          openship_mail: { url, headers: { Authorization: `Bearer ${token}` } },
                        },
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                <Copy />
                Copy MCP config
              </Button>
              <Button size="sm" onClick={() => close(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-5 space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({ name, scopes, expiresInDays: 30 });
            }}
          >
            <label className="block space-y-2 text-[13px]">
              <span>Connection name</span>
              <Input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My desktop agent"
              />
            </label>
            <div className="divide-y rounded-xl border px-3">
              {permissions.map(({ scope, label, description }) => (
                <div key={scope} className="flex items-center justify-between gap-4 py-3">
                  <div className="space-y-1">
                    <label htmlFor={`agent-${scope}`} className="text-[13px]">
                      {label}
                    </label>
                    <p className="text-muted-foreground text-xs">{description}</p>
                  </div>
                  <Switch
                    id={`agent-${scope}`}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(checked) =>
                      setScopes((current) =>
                        checked ? [...current, scope] : current.filter((item) => item !== scope),
                      )
                    }
                  />
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Only this mailbox. Access expires in 30 days.
            </p>
            {create.isError && (
              <p role="alert" className="text-destructive text-[13px]">
                {create.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => close(false)}
                disabled={create.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={create.isPending || !scopes.length}>
                {create.isPending ? "Creating…" : "Create connection"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
