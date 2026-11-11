"use client";
import { reportCaughtError } from "@repo/core/diagnostics";

import { useState, useRef, useEffect, type FormEvent } from "react";
import { CLOUD_API_URL } from "@repo/core";
import Script from "next/script";
import { Check } from "lucide-react";
import "./contact-form.css";
import { CloudSupportReceiptSchema, parseInput, type CloudSupportReceipt } from "@repo/contracts";

type FieldProps = {
  label: string;
  id: string;
  required?: boolean;
  children: React.ReactNode;
};

function Field({ label, id, required, children }: FieldProps) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium mb-2"
        style={{ color: "var(--th-text-body)" }}
      >
        {label}
        {required && <span style={{ color: "var(--th-clr-terra)" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          action: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
        },
      ) => string;
      reset: (id: string) => void;
      remove: (id: string) => void;
    };
  }
}

export function ContactForm({ siteKey }: { siteKey: string }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const showForm = status !== "success";
  const challenge = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  useEffect(() => {
    if (!showForm || !ready || !siteKey || !challenge.current || !window.turnstile) return;
    const turnstile = window.turnstile;
    let active = true;
    const updateToken = (value: string) => {
      if (active) setToken(value);
    };
    const widgetId = turnstile.render(challenge.current, {
      sitekey: siteKey,
      action: "contact",
      callback: updateToken,
      "expired-callback": () => updateToken(""),
      "error-callback": () => updateToken(""),
    });
    widget.current = widgetId;
    return () => {
      active = false;
      turnstile.remove(widgetId);
      widget.current = null;
      setToken("");
    };
  }, [ready, siteKey, showForm]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [errorText, setErrorText] = useState("");
  const [receipt, setReceipt] = useState<CloudSupportReceipt | null>(null);
  const attempt = useRef<{ content: string; requestId: string } | null>(null);
  const sending = useRef(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setStatus("sending");
    setErrorText("");

    try {
      const payload = {
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        message: message.trim(),
        source: "contact",
      };
      const content = JSON.stringify(payload);
      if (attempt.current?.content !== content)
        attempt.current = { content, requestId: crypto.randomUUID() };
      const res = await fetch(`${CLOUD_API_URL.replace(/\/$/, "")}/api/cloud/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          requestId: attempt.current.requestId,
          turnstileToken: token,
        }),
        credentials: "omit",
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Something went wrong.");
      }
      setReceipt(parseInput(CloudSupportReceiptSchema, data));
      setStatus("success");
      setName("");
      setEmail("");
      setSubject("");
      setMessage("");
      attempt.current = null;
    } catch (err) {
      reportCaughtError(err, "web/components/contact-form");
      setStatus("error");
      setErrorText(
        err instanceof Error && err.name !== "TimeoutError" && err.name !== "TypeError"
          ? err.message
          : "Couldn't confirm your request was saved. Your message is still here. Please retry.",
      );
    } finally {
      sending.current = false;
      setToken("");
      if (widget.current) window.turnstile?.reset(widget.current);
    }
  }

  if (status === "success") {
    return (
      <div role="status" className="contact-receipt">
        <span className="contact-receipt-icon" aria-hidden="true">
          <Check size={24} />
        </span>
        <h2>Request received</h2>
        <p>Your request is saved for the Openship team. We’ll reply by email.</p>
        <p>
          Reference: <strong>{receipt?.id}</strong>
        </p>
        <p>Keep this reference. You can reply to the team’s email with more details.</p>
        <button type="button" className="contact-again" onClick={() => setStatus("idle")}>
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit}>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setReady(true)}
        onError={() => {
          setErrorText("Couldn't load the bot check. Please reload and try again.");
          setStatus("error");
        }}
      />
      <Field label="Name" id="contact-name" required>
        <input
          id="contact-name"
          maxLength={120}
          autoComplete="name"
          disabled={status === "sending"}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Your name"
        />
      </Field>
      <Field label="Email" id="contact-email" required>
        <input
          id="contact-email"
          maxLength={254}
          autoComplete="email"
          disabled={status === "sending"}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="you@example.com"
        />
      </Field>
      <Field label="Subject" id="contact-subject" required>
        <input
          id="contact-subject"
          maxLength={200}
          disabled={status === "sending"}
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          placeholder="How can we help?"
        />
      </Field>
      <Field label="Message" id="contact-message" required>
        <textarea
          id="contact-message"
          maxLength={12_000}
          disabled={status === "sending"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          placeholder="Tell us more about your question or issue…"
        />
      </Field>
      {status === "error" && (
        <p role="alert" className="contact-error">
          {errorText}
        </p>
      )}
      <p className="contact-form-note">
        Include the project or deployment reference and the error you see. Please leave out
        passwords, tokens, and payment card details.
      </p>
      <div ref={challenge} aria-label="Bot verification" />
      {!siteKey && (
        <p role="alert" className="contact-error">
          Contact is temporarily unavailable. Please try again later.
        </p>
      )}
      <button type="submit" className="contact-submit" disabled={status === "sending" || !token}>
        {status === "sending" ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
