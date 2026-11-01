"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { CloudSupportCategory, CloudSupportCustomerInput } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSupportApi } from "./support-api";

export function NewSupportTicket({
  initialCategory,
  email,
  onCreated,
}: {
  initialCategory: CloudSupportCategory;
  email: string;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const cloudSupportApi = useSupportApi();
  const copy = t.support;
  const id = useId();
  const [category, setCategory] = useState(initialCategory);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef<CloudSupportCustomerInput | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !subject.trim() || !message.trim()) return;
    const content = { subject: subject.trim(), message: message.trim(), category };
    // A timeout may happen after the ticket commits. Reuse that request on retry.
    if (
      !attempt.current ||
      Object.entries(content).some(
        ([key, value]) => attempt.current![key as keyof typeof content] !== value,
      )
    ) {
      attempt.current = { ...content, requestId: crypto.randomUUID() };
    }
    busy.current = true;
    setSending(true);
    setFailed(false);
    try {
      const receipt = await cloudSupportApi.create(attempt.current);
      if (mounted.current) onCreated(receipt.id);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/support/NewSupportTicket");
      if (mounted.current) setFailed(true);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }

  return (
    <section className="rounded-2xl bg-card p-5 sm:p-6" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
        {copy.newTicket}
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{copy.composeDescription}</p>
      <form onSubmit={submit} className="mt-6 space-y-5" aria-busy={sending}>
        <div className="space-y-2">
          <label htmlFor={`${id}-category`} className="text-sm font-medium">
            {copy.categoryLabel}
          </label>
          <CustomSelect
            id={`${id}-category`}
            value={category}
            onChange={setCategory}
            disabled={sending}
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            aria-label={copy.categoryLabel}
            options={(Object.keys(copy.categories) as CloudSupportCategory[]).map((value) => ({
              value,
              label: copy.categories[value],
            }))}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor={`${id}-subject`} className="text-sm font-medium">
            {copy.subjectLabel}
          </label>
          <Input
            id={`${id}-subject`}
            variant="filled"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={copy.subjectPlaceholder}
            maxLength={200}
            required
            disabled={sending}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <label htmlFor={`${id}-message`} className="text-sm font-medium">
            {copy.messageLabel}
          </label>
          <Textarea
            id={`${id}-message`}
            variant="filled"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={copy.messagePlaceholder}
            maxLength={12000}
            required
            disabled={sending}
            className="min-h-52 resize-y"
          />
        </div>
        <p className="flex items-start gap-2 break-words text-xs leading-5 text-muted-foreground">
          <Icon name="mail" className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-all">{interpolate(copy.signedInAs, { email })}</span>
        </p>
        {failed && (
          <p role="alert" className="rounded-xl bg-danger/5 p-3 text-sm text-danger">
            {copy.createFailed}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href="/support" scroll={false}>
              {copy.cancel}
            </Link>
          </Button>
          <Button type="submit" disabled={sending || !subject.trim() || !message.trim()}>
            <Icon
              name={sending ? "spinner" : "arrow-right"}
              className={`size-4 ${sending ? "animate-spin" : "rtl:rotate-180"}`}
              aria-hidden="true"
            />
            {sending ? copy.sending : copy.sendTicket}
          </Button>
        </div>
      </form>
    </section>
  );
}
