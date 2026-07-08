"use client";

import { Mail } from "lucide-react";
import {
  Callout,
  GuideLayout,
  GuideSection,
  Steps,
} from "../_components/guide-layout";

export default function DesktopGuidePage() {
  return (
    <GuideLayout
      icon={Mail}
      title="Desktop clients"
      subtitle="Thunderbird, Outlook, Apple Mail (covered separately), Spark, K-9 - the IMAP/SMTP setup is identical. This guide uses Thunderbird; the field names match almost every other client."
    >
      <GuideSection title="Universal settings">
        <p className="text-sm leading-relaxed text-white/70">
          Every mail client asks for the same six things. They're all in the
          right rail - copy them as you go:
        </p>
        <Callout>
          <ul className="list-inside list-disc space-y-1 text-sm">
            <li>
              <strong>Username</strong> - your full email address (same on
              both servers).
            </li>
            <li>
              <strong>Password</strong> - from your Openship admin Overview tab.
            </li>
            <li>
              <strong>IMAP server / port / security</strong> - typically port{" "}
              <em>993</em> with <em>SSL/TLS</em>.
            </li>
            <li>
              <strong>SMTP server / port / security</strong> - typically port{" "}
              <em>587</em> with <em>STARTTLS</em>.
            </li>
            <li>
              <strong>Authentication</strong> - "Normal password"
              (not OAuth).
            </li>
          </ul>
        </Callout>
      </GuideSection>

      <GuideSection title="Thunderbird">
        <Steps
          items={[
            <>
              Open Thunderbird. If this is your first account, the setup
              wizard appears automatically. Otherwise: <strong>File</strong>{" "}
              → <strong>New</strong> → <strong>Existing Mail Account</strong>.
            </>,
            <>Enter your name, full email, and password. Click <strong>Continue</strong>.</>,
            <>
              Thunderbird will try to auto-detect. <strong>Stop it</strong>{" "}
              by clicking <strong>Manual config</strong> as soon as the
              option appears - auto-detection often picks the wrong protocol.
            </>,
            <>
              Set the IMAP host, port <strong>993</strong>, SSL/TLS, Normal
              password. SMTP: host, port <strong>587</strong>, STARTTLS,
              Normal password. Username on both = your full email.
            </>,
            <>
              Click <strong>Re-test</strong>. The dots should turn green.
              Click <strong>Done</strong>.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title="Outlook (classic)">
        <Steps
          items={[
            <>
              <strong>File</strong> → <strong>Add Account</strong> →{" "}
              <strong>Advanced options</strong> → check{" "}
              <strong>Let me set up my account manually</strong>.
            </>,
            <>Enter your email → <strong>Connect</strong>.</>,
            <>Choose <strong>IMAP</strong>.</>,
            <>
              Fill the incoming/outgoing servers and ports from the right
              rail. Set incoming encryption to <strong>SSL/TLS</strong> and
              outgoing to <strong>STARTTLS</strong>.
            </>,
            <>
              Enter your password. Outlook will verify; once green, click{" "}
              <strong>Done</strong>.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title="K-9 / Spark / FairEmail (open-source clients)">
        <p className="text-sm leading-relaxed text-white/70">
          The flow is the same on every other IMAP client: when asked,
          choose <strong>Manual setup</strong> → <strong>IMAP</strong>,
          fill the values from the right rail, and avoid any "OAuth" or
          "Google sign-in" options - this is a standalone IMAP/SMTP server,
          not a Google account.
        </p>
      </GuideSection>

      <GuideSection title="Common pitfalls">
        <Callout tone="warning">
          <strong>"Server doesn't trust the certificate"</strong> usually
          means Let's Encrypt hasn't propagated yet (5-15 min after install).
          Accept the cert once and the warning won't repeat.
        </Callout>
        <Callout tone="warning">
          <strong>"Username and password not accepted"</strong> when your
          credentials are correct - check that the username field has your{" "}
          <em>full email</em>, not just the local part before @. This server's
          virtual-mailbox setup requires the full address.
        </Callout>
      </GuideSection>
    </GuideLayout>
  );
}
