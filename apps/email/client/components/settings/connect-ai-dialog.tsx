import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { useTRPC } from "@/providers/query-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiProviderIcon } from "@/components/icons/ai-provider-icon";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ConnectAiDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const [provider, setProvider] = useState<"openai" | "anthropic" | "custom">("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const preparation = useMutation(
    trpc.assistant.prepare.mutationOptions({
      onSuccess: (state) =>
        cache.setQueryData(
          trpc.assistant.preparation.queryKey({ provider: state.provider }),
          state,
        ),
    }),
  );
  const { mutate: prepare } = preparation;
  useEffect(() => {
    if (open) prepare({ provider });
  }, [open, provider, prepare]);
  const progress = useQuery(
    trpc.assistant.preparation.queryOptions(
      { provider },
      {
        enabled: open && preparation.isSuccess && preparation.data.provider === provider,
        refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
        retry: false,
      },
    ),
  );
  const ready = !preparation.isPending && progress.data?.ready;
  const prepareError = preparation.error ?? progress.error;
  const connect = useMutation(
    trpc.assistant.connect.mutationOptions({
      onSuccess: () => {
        setApiKey("");
        onConnected();
        onOpenChange(false);
      },
      onSettled: (_data, _error, variables) => {
        variables.apiKey = "";
        setApiKey("");
      },
    }),
  );
  const close = (value: boolean) => {
    if (connect.isPending) return;
    setApiKey("");
    connect.reset();
    onOpenChange(value);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showOverlay
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl p-5 sm:p-6"
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-base font-medium">Connect AI</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Use your API key to chat and write with AI.
          </DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={connect.isPending}
            aria-label="Close AI connection"
            className="absolute right-3 top-3 size-8"
          >
            <X />
          </Button>
        </DialogClose>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate({
              provider,
              apiKey,
              model,
              ...(provider === "custom" ? { baseUrl, name } : {}),
            });
          }}
        >
          <label className="block space-y-2 text-[13px]">
            <span>Provider</span>
            <Select
              value={provider}
              onValueChange={(value: typeof provider) => {
                setProvider(value);
                setApiKey("");
                setModel("");
                connect.reset();
              }}
              disabled={connect.isPending}
            >
              <SelectTrigger aria-label="AI provider">
                <SelectValue />
                <ChevronDown className="text-muted-foreground size-4" />
              </SelectTrigger>
              <SelectContent className="z-[110]">
                {(
                  [
                    ["openai", "OpenAI"],
                    ["anthropic", "Anthropic"],
                    ["custom", "Custom API"],
                  ] as const
                ).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2.5">
                      <AiProviderIcon provider={value} className="size-4" />
                      {label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {provider === "custom" && (
            <>
              <label className="block space-y-2 text-[13px]">
                <span>Connection name</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="My AI provider"
                  disabled={connect.isPending}
                />
              </label>
              <label className="block space-y-2 text-[13px]">
                <span>API base URL</span>
                <Input
                  type="url"
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  disabled={connect.isPending}
                />
                <span className="text-muted-foreground block text-xs">
                  Requires Responses API and tool calling support.
                </span>
              </label>
            </>
          )}
          <label className="block space-y-2 text-[13px]">
            <span>API key</span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              maxLength={8192}
              disabled={connect.isPending}
            />
          </label>
          <label className="block space-y-2 text-[13px]">
            <span>
              Model{" "}
              {provider !== "custom" && <span className="text-muted-foreground">(optional)</span>}
            </span>
            <Input
              required={provider === "custom"}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              maxLength={200}
              placeholder={
                provider === "custom" ? "Your provider’s model ID" : "Use provider default"
              }
              disabled={connect.isPending}
            />
          </label>
          <p className="text-muted-foreground text-xs leading-relaxed">
            The assistant can read this mailbox and save drafts. Sending always requires your
            approval. API usage is billed by your provider.
          </p>
          {connect.isError && (
            <p role="alert" className="text-destructive text-[13px]">
              {connect.error.message}
            </p>
          )}
          {prepareError ||
          (!preparation.isPending && progress.data && !ready && !progress.data.running) ? (
            <p role="alert" className="text-destructive text-[13px]">
              {prepareError?.message ?? "AI setup could not finish."}{" "}
              <button type="button" className="underline" onClick={() => prepare({ provider })}>
                Retry
              </button>
            </p>
          ) : (
            !ready && (
              <p role="status" className="text-muted-foreground text-xs">
                Preparing your private assistant… You can leave this dialog open while it finishes.
              </p>
            )
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={connect.isPending}
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={connect.isPending || !ready}>
              {connect.isPending ? "Connecting…" : "Connect AI"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
