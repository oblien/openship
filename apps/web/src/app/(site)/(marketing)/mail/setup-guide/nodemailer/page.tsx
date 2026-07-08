"use client";

import { Code2 } from "lucide-react";
import {
  Callout,
  GuideLayout,
  GuideSection,
  Steps,
} from "../_components/guide-layout";
import { CodeBlock } from "../_components/code-block";

export default function NodemailerGuidePage() {
  return (
    <GuideLayout
      icon={Code2}
      title="Send via code"
      subtitle="Send mail from your application using any SMTP library. We show the Node.js / nodemailer flow because it's the most common - every other language uses the exact same fields."
    >
      <GuideSection title="Install nodemailer">
        <CodeBlock language="bash" filename="terminal">
{`npm install nodemailer
# or
pnpm add nodemailer
# or
bun add nodemailer`}
        </CodeBlock>
      </GuideSection>

      <GuideSection title="Minimal transporter">
        <CodeBlock language="ts" filename="mailer.ts">
{`import nodemailer from "nodemailer";

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST!,        // smtp host from the right rail
  port: Number(process.env.SMTP_PORT), // 587
  secure: false,                       // STARTTLS upgrades after connect
  requireTLS: true,                    // refuse if TLS upgrade is unavailable
  auth: {
    user: process.env.SMTP_USER!,      // your full email address
    pass: process.env.SMTP_PASS!,      // postmaster password - keep in .env
  },
});`}
        </CodeBlock>
        <Callout>
          <strong>Why port 587 + STARTTLS instead of 465 + secure: true?</strong>
          {" "}Both work. 587/STARTTLS is the modern submission standard and
          is what most clients pick. 465 (implicit TLS) is supported too -
          set <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px]">port: 465, secure: true</code>{" "}
          and remove <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px]">requireTLS</code>.
        </Callout>
      </GuideSection>

      <GuideSection title="Send a message">
        <CodeBlock language="ts" filename="send.ts">
{`import { transporter } from "./mailer";

await transporter.sendMail({
  from: '"Your App" <postmaster@yourdomain.com>',
  to: "alice@example.com",
  subject: "Hello from your self-hosted mail server",
  text: "Plain-text body.",
  html: "<p>HTML body too - clients pick whichever they prefer.</p>",
});`}
        </CodeBlock>
      </GuideSection>

      <GuideSection title="Verify the connection first">
        <p className="text-sm leading-relaxed text-white/70">
          On boot, ping the server so a broken config fails fast instead of
          waiting for the first sendMail to time out:
        </p>
        <CodeBlock language="ts" filename="boot.ts">
{`await transporter.verify();
console.log("SMTP ready");`}
        </CodeBlock>
      </GuideSection>

      <GuideSection title="From other languages">
        <p className="text-sm leading-relaxed text-white/70">
          The shape is identical across libraries - host, port, TLS mode,
          username, password.
        </p>

        <CodeBlock language="py" filename="python · smtplib">
{`import smtplib
from email.message import EmailMessage

msg = EmailMessage()
msg["From"] = "postmaster@yourdomain.com"
msg["To"] = "alice@example.com"
msg["Subject"] = "Hello"
msg.set_content("Plain text body")

with smtplib.SMTP("smtp.yourdomain.com", 587) as s:
    s.starttls()
    s.login("postmaster@yourdomain.com", "PASSWORD")
    s.send_message(msg)`}
        </CodeBlock>

        <CodeBlock language="go" filename="go · net/smtp">
{`auth := smtp.PlainAuth("",
  "postmaster@yourdomain.com",
  "PASSWORD",
  "smtp.yourdomain.com",
)
err := smtp.SendMail(
  "smtp.yourdomain.com:587",
  auth,
  "postmaster@yourdomain.com",
  []string{"alice@example.com"},
  []byte("Subject: Hello\\r\\n\\r\\nbody"),
)`}
        </CodeBlock>
      </GuideSection>

      <GuideSection title="Production checklist">
        <Steps
          items={[
            <>
              Never commit the password. Use <strong>environment variables</strong>{" "}
              loaded at runtime (Vercel/Railway/Fly all do this; locally
              use <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px]">.env.local</code>).
            </>,
            <>
              Keep a single <strong>transporter</strong> instance for the
              lifetime of your process - opening a fresh TCP+TLS handshake
              per email kills throughput.
            </>,
            <>
              Set the <strong>From</strong> address to a mailbox that exists
              on this server. Foreign From addresses are rejected by your
              SPF + DMARC policy.
            </>,
            <>
              For transactional volume, run <strong>verify()</strong> at boot
              and add retries around <strong>sendMail</strong>; transient
              network blips are normal.
            </>,
            <>
              Check the Health tab in your Openship admin if mail stops
              sending - the outbound queue lives there.
            </>,
          ]}
        />
      </GuideSection>
    </GuideLayout>
  );
}
