import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/providers/query-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsCard } from "./settings-card";
import { toast } from "sonner";
import { m } from "@/paraglide/messages";

export function BlockedSenders() {
  const trpc = useTRPC();
  const state = useQuery(trpc.blockedSenders.list.queryOptions());
  const change = useMutation(trpc.blockedSenders.set.mutationOptions());
  const [email, setEmail] = useState("");
  async function update(sender: string, blocked: boolean) {
    try {
      await change.mutateAsync({ email: sender, blocked });
      await state.refetch();
      if (blocked) setEmail("");
      toast.success(
        blocked
          ? m["pages.settings.privacy.blockedSenders.blocked"]()
          : m["pages.settings.privacy.blockedSenders.unblocked"](),
      );
    } catch {
      toast.error(m["pages.settings.privacy.blockedSenders.failed"]());
    }
  }
  return (
    <SettingsCard
      title={m["pages.settings.privacy.blockedSenders.title"]()}
      description={m["pages.settings.privacy.blockedSenders.description"]()}
    >
      {state.isPending ? (
        <p>{m["pages.settings.privacy.blockedSenders.loading"]()}</p>
      ) : state.error ? (
        <div role="alert">
          <p>{m["pages.settings.privacy.blockedSenders.unavailable"]()}</p>
          <Button variant="outline" onClick={() => void state.refetch()}>
            {m["pages.settings.privacy.blockedSenders.retry"]()}
          </Button>
        </div>
      ) : (
        <>
          {state.data?.senders.length && !state.data.active ? (
            <p role="alert">{m["pages.settings.privacy.blockedSenders.inactive"]()}</p>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void update(email, true);
            }}
          >
            <Input
              type="email"
              required
              maxLength={254}
              aria-label={m["pages.settings.privacy.blockedSenders.emailLabel"]()}
              placeholder="sender@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" disabled={change.isPending || !email.trim()}>
              {m["pages.settings.privacy.blockedSenders.block"]()}
            </Button>
          </form>
          <ul className="mt-4 space-y-2">
            {state.data?.senders.map((sender) => (
              <li key={sender} className="flex items-center justify-between gap-3">
                <span className="break-all">{sender}</span>
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => void update(sender, false)}
                >
                  {m["pages.settings.privacy.blockedSenders.unblock"]()}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsCard>
  );
}
