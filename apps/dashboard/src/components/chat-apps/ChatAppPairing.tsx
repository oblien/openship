"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AssistantAuthorization } from "@repo/contracts";
import { chatAppsApi } from "@/lib/api/chat-apps";
import { useScopedMutation } from "@/hooks/use-scoped-resource";
import { McpAuthorizationForm } from "@/components/permissions/McpAuthorizationForm";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
export function ChatAppPairing() {
  const query = useSearchParams(),
    router = useRouter(),
    action = useScopedMutation();
  const [consent, setConsent] = useState<
    (AssistantAuthorization & { connectionName: string }) | null
  >(null);
  const [verified, setVerified] = useState<{ verification: string; connectionName: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false),
    started = useRef<string | null>(null);
  const challenge = query.get("link"),
    code = query.get("code"),
    state = query.get("state");
  const [busy, setBusy] = useState(false);
  const open = !!(challenge || code || consent || verified);
  const close = () => {
    if (busy || action.busy) return;
    setConsent(null);
    setVerified(null);
    router.replace("/settings?tab=chat-apps");
  };
  const focus = useDialogFocus(close, open);
  useEffect(() => {
    const key = challenge ?? (code && state ? `${state}:${code}` : null);
    if (!key || started.current === key) return;
    started.current = key;
    if (challenge)
      void action
        .execute(() => chatAppsApi.pair(challenge))
        .then((v) => {
          if (v) setConsent(v);
        });
    else if (code && state)
      void action
        .execute(() => chatAppsApi.complete(state, code))
        .then((v) => {
          if (v) setVerified(v);
        });
  }, [challenge, code, state, open]);
  return (
    <Modal
      isOpen={open}
      onClose={close}
      closable={!busy && !action.busy}
      width={consent ? "1050px" : "600px"}
      maxWidth="calc(100vw - 32px)"
      height={consent ? "min(850px, calc(100dvh - 32px))" : "auto"}
      maxHeight="calc(100dvh - 32px)"
      overflow={consent ? "hidden" : "auto"}
    >
      <div
        ref={focus.dialog}
        onKeyDown={focus.onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Link your chat account"
        tabIndex={-1}
        className={
          consent && !action.error
            ? "flex min-h-0 flex-1 flex-col outline-none"
            : "p-6 sm:p-8 outline-none"
        }
      >
        {action.error ? (
          <>
            <h2 className="text-xl font-medium">Couldn’t link your account</h2>
            <p role="alert" className="mt-3 text-sm text-destructive">
              {action.error}
            </p>
            <Button onClick={close} className="mt-6">
              Close
            </Button>
          </>
        ) : verified ? (
          <>
            <h2 className="text-xl font-medium">One last step in {verified.connectionName}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Send this command in the same conversation, from the chat account you’re connecting.
              It expires in 5 minutes.
            </p>
            <code className="mt-5 block break-all rounded-xl bg-background p-4 text-sm">
              /openship verify {verified.verification}
            </code>
            <div className="mt-5 flex gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`/openship verify ${verified.verification}`)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Button variant="ghost" onClick={close}>
                Done
              </Button>
            </div>
          </>
        ) : consent ? (
          <McpAuthorizationForm
            clientId={consent.clientId}
            consentCode={consent.consentCode}
            organizationId={consent.organizationId}
            presentation="chat"
            onBusyChange={setBusy}
            onComplete={async (uri, accepted) => {
              if (!accepted) {
                setBusy(false);
                setConsent(null);
                router.replace("/settings?tab=chat-apps");
                return;
              }
              const result = await action.execute(async () => {
                const url = uri ? new URL(uri) : null;
                if (
                  !url?.pathname.endsWith("/api/chat-apps/callback") ||
                  url.searchParams.get("state") !== consent.state ||
                  !url.searchParams.get("code")
                )
                  throw new Error("Invalid authorization response.");
                return chatAppsApi.complete(consent.state, url.searchParams.get("code")!);
              });
              // The consent form unmounts on success, before it can report its idle state.
              setBusy(false);
              if (result) {
                setVerified(result);
                setConsent(null);
                router.replace("/settings?tab=chat-apps");
              }
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Preparing your permissions…</p>
        )}
      </div>
    </Modal>
  );
}
