"use client";

import { useState, type FormEvent } from "react";

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

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [errorText, setErrorText] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorText("");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Something went wrong.");
      }

      setStatus("success");
      setName("");
      setEmail("");
      setSubject("");
      setMessage("");
    } catch (err) {
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (status === "success") {
    return (
      <div style={{ textAlign: "center", padding: "80px 0" }}>
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
          Message sent
        </h2>
        <p className="legal-p" style={{ color: "var(--th-text-body)", margin: "0 0 32px 0" }}>
          Thanks for reaching out. We&rsquo;ll get back to you shortly.
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
          <p style={{ fontSize: 14, color: "var(--th-clr-terra)", margin: 0 }}>
            {errorText}
          </p>
        )}

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
