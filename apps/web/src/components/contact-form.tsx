"use client";
import { reportCaughtError } from "@repo/core/diagnostics";


import { useState, useRef, type FormEvent } from "react";
import { SUPPORT_EMAIL } from "@repo/core";
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 44,
  borderRadius: 10,
  border: "1px solid var(--th-bd-default)",
  background: "var(--th-bg-card)",
  padding: "0 14px",
  fontSize: 15,
  color: "var(--th-text-heading)",
  outline: "none",
  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid var(--th-bd-default)",
  background: "var(--th-bg-card)",
  padding: "12px 14px",
  fontSize: 15,
  color: "var(--th-text-heading)",
  outline: "none",
  resize: "vertical",
  minHeight: 140,
  fontFamily: "inherit",
  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
};

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
      const payload = { name: name.trim(), email: email.trim(), subject: subject.trim(), message: message.trim(), source };
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
      setErrorText(err instanceof Error && err.name !== "TimeoutError" && err.name !== "TypeError"
        ? err.message
        : "Couldn't confirm your request was saved. Your message is still here. Please retry.");
    } finally {
      sending.current = false;
    }
  }

  if (status === "success") {
    return (
      <div role="status" style={{ textAlign: "center", padding: "48px 0" }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "var(--th-clr-sea-wash)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 24px",
            fontSize: 32,
            color: "var(--th-clr-sea)",
            animation: "scale-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        >
          ✓
        </div>
        <h2 className="legal-section-title" style={{ marginBottom: 8 }}>
          Request received
        </h2>
        <p className="legal-p" style={{ color: "var(--th-text-body)", margin: "0 0 32px 0" }}>
          Your request is saved for the Openship team. We&rsquo;ll reply by email.
        </p>
        <p className="legal-p">Reference: <strong style={{ overflowWrap: "anywhere" }}>{receipt?.id}</strong></p>
        <p className="legal-p" style={{ marginBottom: 24 }}>
          Keep this reference. You can send more details to <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`[${receipt?.id}] Support request`)}`}>{SUPPORT_EMAIL}</a>.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          style={{
            background: "transparent",
            border: "1px solid var(--th-bd-default)",
            borderRadius: 10,
            padding: "10px 24px",
            fontSize: 14,
            color: "var(--th-text-body)",
            cursor: "pointer",
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--th-bd-strong)";
            e.currentTarget.style.background = "var(--th-bg-card)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--th-bd-default)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <>
      <style>{`@keyframes scale-in{from{transform:scale(0.8);opacity:0}to{transform:scale(1);opacity:1}}`}</style>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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
            style={inputStyle}
            placeholder="Your name"
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-strong)";
              e.currentTarget.style.boxShadow = "0 0 0 3px var(--th-sf-04)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-default)";
              e.currentTarget.style.boxShadow = "none";
            }}
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
            style={inputStyle}
            placeholder="you@example.com"
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-strong)";
              e.currentTarget.style.boxShadow = "0 0 0 3px var(--th-sf-04)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-default)";
              e.currentTarget.style.boxShadow = "none";
            }}
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
            style={inputStyle}
            placeholder="How can we help?"
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-strong)";
              e.currentTarget.style.boxShadow = "0 0 0 3px var(--th-sf-04)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-default)";
              e.currentTarget.style.boxShadow = "none";
            }}
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
            style={textareaStyle}
            placeholder="Tell us more about your question or issue..."
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-strong)";
              e.currentTarget.style.boxShadow = "0 0 0 3px var(--th-sf-04)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--th-bd-default)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
        </Field>

        {status === "error" && (
          <p role="alert" style={{ fontSize: 14, color: "var(--th-clr-terra)", margin: 0 }}>
            {errorText}
          </p>
        )}
        <p className="legal-p" style={{ margin: 0, fontSize: 14 }}>
          Include the project or deployment reference and the error you see. Please leave out passwords, tokens, and payment card details.
        </p>

        <button
          type="submit"
          disabled={status === "sending"}
          style={{
            height: 48,
            borderRadius: 10,
            border: "none",
            background: "var(--th-btn-bg)",
            color: "var(--th-btn-text)",
            fontSize: 15,
            fontWeight: 500,
            cursor: status === "sending" ? "not-allowed" : "pointer",
            opacity: status === "sending" ? 0.65 : 1,
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
          onMouseEnter={(e) => {
            if (status !== "sending") {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 8px 16px rgba(0, 0, 0, 0.12)";
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          {status === "sending" ? "Sending..." : "Send message"}
        </button>
      </form>
    </>
  );
}
