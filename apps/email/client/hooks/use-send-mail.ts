import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/providers/query-provider";
import { readActiveConnectionId } from "@/lib/auth-client";

/** Keep the same request id when a send acknowledgement is lost and the user retries. */
export function useSendMail() {
  const trpc = useTRPC();
  const mutation = useMutation(trpc.mail.send.mutationOptions());
  const pending = useRef<{ key: string; id: string } | null>(null);
  return async (input: Omit<Parameters<typeof mutation.mutateAsync>[0], "requestId">) => {
    const connection = readActiveConnectionId();
    if (!connection) throw new Error("Sign in before sending mail.");
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(input)),
    );
    const key = `${connection}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (connection !== readActiveConnectionId())
      throw new Error("The mailbox changed. Review your message before sending.");
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    const requestId = pending.current.id;
    const result = await mutation.mutateAsync({ ...input, requestId });
    if (pending.current?.id === requestId) pending.current = null;
    return result;
  };
}
