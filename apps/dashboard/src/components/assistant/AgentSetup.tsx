"use client";

import { ASSISTANT_PROVIDER_LABELS, type AssistantProviderInfo } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { assistantApi } from "@/lib/api/assistant";

/** Native and custom connections share the host's existing Mindwire setup job. */
export function AgentSetup({
  info,
  onRefresh,
}: {
  info: AssistantProviderInfo;
  onRefresh(): void;
}) {
  const action = useScopedMutation();
  if (info.available) return null;
  const busy = action.busy || info.setup?.state === "installing";
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">
        {info.issue ||
          (info.setup
            ? `Set up ${ASSISTANT_PROVIDER_LABELS[info.id]} on your assistant host to connect.`
            : `Install ${ASSISTANT_PROVIDER_LABELS[info.id]} on your assistant host, then refresh this connection.`)}
      </p>
      {info.setup && (
        <Button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (await action.execute(() => assistantApi.setupProvider(info.id))) onRefresh();
          }}
        >
          {busy ? (
            <>
              <Icon name="spinner" className="size-4 animate-spin motion-reduce:animate-none" />
              Setting up…
            </>
          ) : info.setup.state === "failed" ? (
            "Retry setup"
          ) : (
            `Set up ${ASSISTANT_PROVIDER_LABELS[info.id]}`
          )}
        </Button>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-danger">
          {action.error}
        </p>
      )}
    </div>
  );
}
