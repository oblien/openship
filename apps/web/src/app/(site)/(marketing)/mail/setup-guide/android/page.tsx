"use client";

import { Smartphone } from "lucide-react";
import {
  Callout,
  GuideLayout,
  GuideSection,
  Steps,
} from "../_components/guide-layout";

export default function AndroidGuidePage() {
  return (
    <GuideLayout
      icon={Smartphone}
      title="Android Gmail app"
      subtitle="Add your mailbox to the Gmail app on Android as a third-party IMAP account. Same flow works on Android 12 through 15; menu wording may vary slightly between OEM skins."
    >
      <GuideSection title="Before you start">
        <p className="text-sm leading-relaxed text-white/70">
          You need the username and password from your Openship admin Overview tab,
          plus the IMAP / SMTP host and port shown in the right rail. Tap{" "}
          <em>"Manual setup"</em> when offered - auto-detection often picks
          the wrong port.
        </p>
      </GuideSection>

      <GuideSection title="Add the account">
        <Steps
          items={[
            <>
              Open <strong>Gmail</strong>. Tap your profile avatar (top right)
              → <strong>Add another account</strong>.
            </>,
            <>
              Choose <strong>Other</strong> (not Google, not Outlook).
            </>,
            <>
              Enter your full email address (the{" "}
              <em>Username</em> from the right rail) → tap{" "}
              <strong>Manual setup</strong>.
            </>,
            <>
              Choose <strong>Personal (IMAP)</strong>.
            </>,
            <>
              Enter your password → <strong>Next</strong>.
            </>,
            <>
              <strong>Incoming server settings</strong>: leave the username
              as your full email. Set the server to the IMAP host from the
              right rail. Port <strong>993</strong>, security type{" "}
              <strong>SSL/TLS</strong>. Tap <strong>Next</strong>.
            </>,
            <>
              <strong>Outgoing server settings</strong>: server = the SMTP
              host. Port <strong>587</strong>, security type{" "}
              <strong>STARTTLS</strong>. Keep "Require sign-in" enabled and
              re-enter your password. Tap <strong>Next</strong>.
            </>,
            <>
              Pick your sync frequency (15 min is fine) → enter a display
              name → <strong>Next</strong>. The account is added.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title="Push notifications">
        <Callout>
          Gmail polls IMAP at the interval you chose; it does <em>not</em>{" "}
          use IDLE for non-Google accounts. For near-instant notifications,
          install a dedicated IMAP-IDLE client like FairEmail or K-9. The
          settings are identical.
        </Callout>
      </GuideSection>

      <GuideSection title="If sign-in fails">
        <Callout tone="warning">
          The error <em>"Couldn't open connection to server"</em> almost
          always means a port/security mismatch. Re-open the account from
          Gmail's settings, tap your address, then{" "}
          <strong>Server settings</strong>, and verify ports{" "}
          <strong>993 + SSL/TLS</strong> incoming and{" "}
          <strong>587 + STARTTLS</strong> outgoing.
        </Callout>
      </GuideSection>
    </GuideLayout>
  );
}
