"use client";
import { reportCaughtError } from "@repo/core/diagnostics";

import { useState, useRef, type FormEvent } from "react";
import { SUPPORT_EMAIL } from "@repo/core";
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

export function ContactForm({ source = "contact" }: { source?: "support" | "contact" }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
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
        source,
      };
      const content = JSON.stringify(payload);
      if (attempt.current?.content !== content)
        attempt.current = { content, requestId: crypto.randomUUID() };
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: attempt.current.requestId }),
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
        <p>
          Keep this reference. You can send more details to{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`[${receipt?.id}] Support request`)}`}
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <button type="button" className="contact-again" onClick={() => setStatus("idle")}>
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit}>
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
      <button type="submit" className="contact-submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
