"use client";
import { useCopy } from "@/i18n/use-copy";

import { Smartphone } from "lucide-react";
import { Callout, GuideLayout, GuideSection, Steps } from "../_components/guide-layout";

export default function AndroidGuidePage() {
  const copy = useCopy();

  return (
    <GuideLayout
      icon={Smartphone}
      title={copy("Android Gmail app")}
      subtitle={copy(
        "Add your mailbox to the Gmail app on Android as a third-party IMAP account. Same flow works on Android 12 through 15; menu wording may vary slightly between OEM skins.",
      )}
    >
      <GuideSection title={copy("Before you start")}>
        <p className="text-sm leading-relaxed text-white/70">
          {copy(
            "You need the username and password from your OpenShip admin Overview tab, plus the IMAP / SMTP host and port shown in the right rail. Tap",
          )}{" "}
          <em>{copy('"Manual setup"')}</em>{" "}
          {copy(" when offered - auto-detection often picks the wrong port.")}
        </p>
      </GuideSection>

      <GuideSection title={copy("Add the account")}>
        <Steps
          items={[
            <>
              {copy(" Open ")}
              <strong>{copy("Gmail")}</strong>
              {copy(". Tap your profile avatar (top right) → ")}
              <strong>{copy("Add another account")}</strong>.
            </>,
            <>
              {copy(" Choose ")}
              <strong>{copy("Other")}</strong> {copy(" (not Google, not Outlook). ")}
            </>,
            <>
              {copy(" Enter your full email address (the")} <em>{copy("Username")}</em>{" "}
              {copy(" from the right rail) → tap")} <strong>{copy("Manual setup")}</strong>.
            </>,
            <>
              {copy(" Choose ")}
              <strong>{copy("Personal (IMAP)")}</strong>.
            </>,
            <>
              {copy(" Enter your password → ")}
              <strong>{copy("Next")}</strong>.
            </>,
            <>
              <strong>{copy("Incoming server settings")}</strong>
              {copy(
                ": leave the username as your full email. Set the server to the IMAP host from the right rail. Port ",
              )}
              <strong>993</strong>
              {copy(", security type")} <strong>{copy("SSL/TLS")}</strong>
              {copy(". Tap ")}
              <strong>{copy("Next")}</strong>.
            </>,
            <>
              <strong>{copy("Outgoing server settings")}</strong>
              {copy(": server = the SMTP host. Port ")}
              <strong>587</strong>
              {copy(", security type")} <strong>STARTTLS</strong>
              {copy('. Keep "Require sign-in" enabled and re-enter your password. Tap ')}
              <strong>{copy("Next")}</strong>.
            </>,
            <>
              {copy(" Pick your sync frequency (15 min is fine) → enter a display name → ")}
              <strong>{copy("Next")}</strong>
              {copy(". The account is added. ")}
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title={copy("Push notifications")}>
        <Callout>
          {copy("Gmail polls IMAP at the interval you chose; it does ")}
          <em>{copy("not")}</em>{" "}
          {copy(
            "use IDLE for non-Google accounts. For near-instant notifications, install a dedicated IMAP-IDLE client like FairEmail or K-9. The settings are identical.",
          )}
        </Callout>
      </GuideSection>

      <GuideSection title={copy("If sign-in fails")}>
        <Callout tone="warning">
          {copy("The error ")}
          <em>{copy('"Couldn\'t open connection to server"')}</em>{" "}
          {copy(
            " almost always means a port/security mismatch. Re-open the account from Gmail's settings, tap your address, then",
          )}{" "}
          <strong>{copy("Server settings")}</strong>
          {copy(", and verify ports")} <strong>{copy("993 + SSL/TLS")}</strong>{" "}
          {copy(" incoming and")} <strong>{copy("587 + STARTTLS")}</strong> {copy(" outgoing.")}
        </Callout>
      </GuideSection>
    </GuideLayout>
  );
}
