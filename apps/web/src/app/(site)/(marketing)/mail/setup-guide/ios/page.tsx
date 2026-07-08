"use client";

import { Apple } from "lucide-react";
import {
  Callout,
  GuideLayout,
  GuideSection,
  Steps,
} from "../_components/guide-layout";

export default function IosGuidePage() {
  return (
    <GuideLayout
      icon={Apple}
      title="iOS & macOS Mail"
      subtitle="Add your mailbox to Apple's built-in Mail app on iPhone, iPad, or Mac. The flow is identical on all three; screenshots assume iPhone."
    >
      <GuideSection title="Before you start">
        <p className="text-sm leading-relaxed text-white/70">
          You need the username and password from your Openship admin Overview tab,
          plus the IMAP / SMTP host and port shown in the right rail. iOS will
          auto-fill some fields after you enter your email - double-check them
          against the values here before tapping Done.
        </p>
      </GuideSection>

      <GuideSection title="Add the account">
        <Steps
          items={[
            <>
              Open <strong>Settings</strong> → <strong>Mail</strong> →{" "}
              <strong>Accounts</strong> →{" "}
              <strong>Add Account</strong> → <strong>Other</strong>.
            </>,
            <>Tap <strong>Add Mail Account</strong>.</>,
            <>
              Enter a display name, your full email address (the
              <em> Username</em> from the right rail), the password, and an
              optional description (e.g. "Work mail"). Tap{" "}
              <strong>Next</strong>.
            </>,
            <>
              On the next screen, make sure <strong>IMAP</strong> is selected
              at the top.
            </>,
            <>
              Fill the <strong>Incoming Mail Server</strong> section using the
              IMAP host, port, and your full email as the username.
            </>,
            <>
              Fill the <strong>Outgoing Mail Server</strong> section using the
              SMTP host and port. Username and password are required here too
              - iOS sometimes shows them as "Optional", but with this server
              they are mandatory.
            </>,
            <>
              Tap <strong>Next</strong>. iOS will verify the connection,
              which can take 20–60 seconds. Once it succeeds, choose which
              data to sync (Mail is enough) and tap <strong>Save</strong>.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title="If verification fails">
        <Callout tone="warning">
          The most common cause is a <strong>port</strong> or{" "}
          <strong>security</strong> mismatch. Re-open the account, go to
          Advanced, and confirm: IMAP uses port <strong>993</strong> with{" "}
          <em>Use SSL</em> on; SMTP uses port <strong>587</strong> with{" "}
          <em>Use SSL</em> on and authentication set to <em>Password</em>.
        </Callout>
        <Callout>
          If you keep seeing <em>"Cannot Verify Server Identity"</em>, accept
          the certificate the first time - Let's Encrypt's chain is sometimes
          slow to validate on freshly-issued certs. After 5 minutes the
          warning goes away.
        </Callout>
      </GuideSection>

      <GuideSection title="Send a test">
        <Steps
          items={[
            <>
              Open the <strong>Mail</strong> app. Your new account appears
              alongside any others.
            </>,
            <>
              Compose a message to yourself. Send it from your new address.
            </>,
            <>
              It should arrive in your inbox within seconds. If it lands in
              spam, your DMARC policy is being strict - check the DNS tab
              in the admin panel and verify the SPF/DKIM/DMARC records are
              published.
            </>,
          ]}
        />
      </GuideSection>
    </GuideLayout>
  );
}
