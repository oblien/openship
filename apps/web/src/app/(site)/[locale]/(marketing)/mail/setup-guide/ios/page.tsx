"use client";
import { useCopy } from "@/i18n/use-copy";

import { Apple } from "lucide-react";
import { Callout, GuideLayout, GuideSection, Steps } from "../_components/guide-layout";

export default function IosGuidePage() {
  const copy = useCopy();

  return (
    <GuideLayout
      icon={Apple}
      title={copy("iOS & macOS Mail")}
      subtitle={copy(
        "Add your mailbox to Apple's built-in Mail app on iPhone, iPad, or Mac. The flow is identical on all three; screenshots assume iPhone.",
      )}
    >
      <GuideSection title={copy("Before you start")}>
        <p className="text-sm leading-relaxed text-white/70">
          {copy(
            "You need the username and password from your OpenShip admin Overview tab, plus the IMAP / SMTP host and port shown in the right rail. iOS will auto-fill some fields after you enter your email - double-check them against the values here before tapping Done.",
          )}
        </p>
      </GuideSection>

      <GuideSection title={copy("Add the account")}>
        <Steps
          items={[
            <>
              {copy(" Open ")}
              <strong>{copy("Settings")}</strong> → <strong>{copy("Mail")}</strong> →{" "}
              <strong>{copy("Accounts")}</strong> → <strong>{copy("Add Account")}</strong> →{" "}
              <strong>{copy("Other")}</strong>.
            </>,
            <>
              {copy("Tap ")}
              <strong>{copy("Add Mail Account")}</strong>.
            </>,
            <>
              {copy(" Enter a display name, your full email address (the ")}
              <em> {copy(" Username")}</em>{" "}
              {copy(
                ' from the right rail), the password, and an optional description (e.g. "Work mail"). Tap',
              )}{" "}
              <strong>{copy("Next")}</strong>.
            </>,
            <>
              {copy(" On the next screen, make sure ")}
              <strong>IMAP</strong> {copy(" is selected at the top. ")}
            </>,
            <>
              {copy(" Fill the ")}
              <strong>{copy("Incoming Mail Server")}</strong>{" "}
              {copy(" section using the IMAP host, port, and your full email as the username. ")}
            </>,
            <>
              {copy(" Fill the ")}
              <strong>{copy("Outgoing Mail Server")}</strong>{" "}
              {copy(
                ' section using the SMTP host and port. Username and password are required here too - iOS sometimes shows them as "Optional", but with this server they are mandatory. ',
              )}
            </>,
            <>
              {copy(" Tap ")}
              <strong>{copy("Next")}</strong>
              {copy(
                ". iOS will verify the connection, which can take 20–60 seconds. Once it succeeds, choose which data to sync (Mail is enough) and tap ",
              )}
              <strong>{copy("Save")}</strong>.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title={copy("If verification fails")}>
        <Callout tone="warning">
          {copy("The most common cause is a ")}
          <strong>{copy("port")}</strong> {copy(" or")} <strong>{copy("security")}</strong>{" "}
          {copy(" mismatch. Re-open the account, go to Advanced, and confirm: IMAP uses port ")}
          <strong>993</strong> {copy(" with")} <em>{copy("Use SSL")}</em>{" "}
          {copy(" on; SMTP uses port ")}
          <strong>587</strong> {copy(" with")} <em>{copy("Use SSL")}</em>{" "}
          {copy(" on and authentication set to ")}
          <em>{copy("Password")}</em>.
        </Callout>
        <Callout>
          {copy("If you keep seeing ")}
          <em>{copy('"Cannot Verify Server Identity"')}</em>
          {copy(
            ", accept the certificate the first time - Let's Encrypt's chain is sometimes slow to validate on freshly-issued certs. After 5 minutes the warning goes away.",
          )}
        </Callout>
      </GuideSection>

      <GuideSection title={copy("Send a test")}>
        <Steps
          items={[
            <>
              {copy(" Open the ")}
              <strong>{copy("Mail")}</strong>{" "}
              {copy(" app. Your new account appears alongside any others. ")}
            </>,
            <>{copy(" Compose a message to yourself. Send it from your new address. ")}</>,
            <>
              {copy(
                " It should arrive in your inbox within seconds. If it lands in spam, your DMARC policy is being strict - check the DNS tab in the admin panel and verify the SPF/DKIM/DMARC records are published. ",
              )}
            </>,
          ]}
        />
      </GuideSection>
    </GuideLayout>
  );
}
