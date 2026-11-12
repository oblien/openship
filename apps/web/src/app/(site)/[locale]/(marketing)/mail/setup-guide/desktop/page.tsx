"use client";
import { useCopy } from "@/i18n/use-copy";

import { Mail } from "lucide-react";
import { Callout, GuideLayout, GuideSection, Steps } from "../_components/guide-layout";

export default function DesktopGuidePage() {
  const copy = useCopy();

  return (
    <GuideLayout
      icon={Mail}
      title={copy("Desktop clients")}
      subtitle={copy(
        "Thunderbird, Outlook, Apple Mail (covered separately), Spark, K-9 - the IMAP/SMTP setup is identical. This guide uses Thunderbird; the field names match almost every other client.",
      )}
    >
      <GuideSection title={copy("Universal settings")}>
        <p className="text-sm leading-relaxed text-white/70">
          {copy(
            "Every mail client asks for the same six things. They're all in the right rail - copy them as you go:",
          )}
        </p>
        <Callout>
          <ul className="list-inside list-disc space-y-1 text-sm">
            <li>
              <strong>{copy("Username")}</strong>{" "}
              {copy(" - your full email address (same on both servers).")}
            </li>
            <li>
              <strong>{copy("Password")}</strong>{" "}
              {copy(" - from your OpenShip admin Overview tab.")}
            </li>
            <li>
              <strong>{copy("IMAP server / port / security")}</strong> {copy(" - typically port")}{" "}
              <em>993</em> {copy(" with ")}
              <em>{copy("SSL/TLS")}</em>.
            </li>
            <li>
              <strong>{copy("SMTP server / port / security")}</strong> {copy(" - typically port")}{" "}
              <em>587</em> {copy(" with ")}
              <em>{copy("STARTTLS")}</em>.
            </li>
            <li>
              <strong>{copy("Authentication")}</strong> {copy(' - "Normal password" (not OAuth).')}
            </li>
          </ul>
        </Callout>
      </GuideSection>

      <GuideSection title={copy("Thunderbird")}>
        <Steps
          items={[
            <>
              {copy(
                " Open Thunderbird. If this is your first account, the setup wizard appears automatically. Otherwise: ",
              )}
              <strong>{copy("File")}</strong> → <strong>{copy("New")}</strong> →{" "}
              <strong>{copy("Existing Mail Account")}</strong>.
            </>,
            <>
              {copy("Enter your name, full email, and password. Click ")}
              <strong>{copy("Continue")}</strong>.
            </>,
            <>
              {copy(" Thunderbird will try to auto-detect. ")}
              <strong>{copy("Stop it")}</strong> {copy(" by clicking ")}
              <strong>{copy("Manual config")}</strong>{" "}
              {copy(
                " as soon as the option appears - auto-detection often picks the wrong protocol. ",
              )}
            </>,
            <>
              {copy(" Set the IMAP host, port ")}
              <strong>993</strong>
              {copy(", SSL/TLS, Normal password. SMTP: host, port ")}
              <strong>587</strong>
              {copy(", STARTTLS, Normal password. Username on both = your full email. ")}
            </>,
            <>
              {copy(" Click ")}
              <strong>{copy("Re-test")}</strong>
              {copy(". The dots should turn green. Click ")}
              <strong>{copy("Done")}</strong>.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title={copy("Outlook (classic)")}>
        <Steps
          items={[
            <>
              <strong>{copy("File")}</strong> → <strong>{copy("Add Account")}</strong> →{" "}
              <strong>{copy("Advanced options")}</strong> {copy(" → check")}{" "}
              <strong>{copy("Let me set up my account manually")}</strong>.
            </>,
            <>
              {copy("Enter your email → ")}
              <strong>{copy("Connect")}</strong>.
            </>,
            <>
              {copy("Choose ")}
              <strong>IMAP</strong>.
            </>,
            <>
              {copy(
                " Fill the incoming/outgoing servers and ports from the right rail. Set incoming encryption to ",
              )}
              <strong>{copy("SSL/TLS")}</strong> {copy(" and outgoing to ")}
              <strong>STARTTLS</strong>.
            </>,
            <>
              {copy(" Enter your password. Outlook will verify; once green, click")}{" "}
              <strong>{copy("Done")}</strong>.
            </>,
          ]}
        />
      </GuideSection>

      <GuideSection title={copy("K-9 / Spark / FairEmail (open-source clients)")}>
        <p className="text-sm leading-relaxed text-white/70">
          {copy("The flow is the same on every other IMAP client: when asked, choose ")}
          <strong>{copy("Manual setup")}</strong> → <strong>IMAP</strong>
          {copy(
            ', fill the values from the right rail, and avoid any "OAuth" or "Google sign-in" options - this is a standalone IMAP/SMTP server, not a Google account.',
          )}
        </p>
      </GuideSection>

      <GuideSection title={copy("Common pitfalls")}>
        <Callout tone="warning">
          <strong>{copy('"Server doesn\'t trust the certificate"')}</strong>{" "}
          {copy(
            " usually means Let's Encrypt hasn't propagated yet (5-15 min after install). Accept the cert once and the warning won't repeat.",
          )}
        </Callout>
        <Callout tone="warning">
          <strong>{copy('"Username and password not accepted"')}</strong>{" "}
          {copy(" when your credentials are correct - check that the username field has your")}{" "}
          <em>{copy("full email")}</em>
          {copy(
            ", not just the local part before @. This server's virtual-mailbox setup requires the full address.",
          )}
        </Callout>
      </GuideSection>
    </GuideLayout>
  );
}
