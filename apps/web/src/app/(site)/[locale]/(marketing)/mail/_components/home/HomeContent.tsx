import { ArrowRight } from "lucide-react";
import { CLOUD_DASHBOARD_URL } from "@repo/core";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { Footer } from "@/components/landing/footer";
import { MarketingIntro } from "@/components/marketing/marketing-intro";
import { MarketingSection } from "@/components/marketing/marketing-section";
import { IllustratedLink } from "@/components/marketing/illustrated-link";
import { MailPreview } from "@/components/marketing/mail-preview";
import { MAIL_FEATURES } from "@/lib/mail-features";
import "../../mail.css";

const CLIENT_GUIDES = [
  { href: "/mail/setup-guide/ios", label: "iPhone & iPad" },
  { href: "/mail/setup-guide/android", label: "Android" },
  { href: "/mail/setup-guide/desktop", label: "Desktop clients" },
];

export default function HomeContent() {
  const copy = useCopy();

  return (
    <>
      <main className="marketing-page mail-page">
        <MarketingIntro
          eyebrow={<><FeatureIllustration name="mail" className="marketing-illustration" />OpenShip Mail</>}
          title={<>{copy("Your email.")}<br /><span>{copy("Your control panel.")}</span></>}
          description="Team inboxes and transactional email on your own server. Manage accounts, delivery, and backups alongside your apps."
        >
          <div className="mail-actions">
            <Link href="/download" className="th-btn rounded-full px-6 py-3 text-[14px]">
              {copy("Get OpenShip")}<ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link href="#control-panel" className="marketing-text-link">
              {copy("Explore the panel")}<ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          <span>{copy("Mail server management for Desktop and self-hosted OpenShip.")}</span>
        </MarketingIntro>

        <div className="site-container mail-hero-preview">
          <MailPreview priority sizes="(max-width: 1600px) 85vw, 1400px" />
        </div>

        <div className="site-container marketing-content">
          <MarketingSection
            id="control-panel"
            title="The whole mail server, in view."
            description="From adding an account to finding a delivery problem."
          >
            <div className="marketing-grid">
              {MAIL_FEATURES.map(({ id, ...feature }) => <IllustratedLink key={id} {...feature} />)}
            </div>
          </MarketingSection>

          <MarketingSection
            id="mail-clients"
            title="An inbox wherever you work."
            description="Use webmail, your favorite email app, or your own code."
          >
            <div className="mail-client-options">
              <article>
                <FeatureIllustration name="dashboard-cli-desktop" className="marketing-illustration" />
                <h3>{copy("Webmail & email clients")}</h3>
                <p>{copy("Open your inbox in a browser, or connect an IMAP/SMTP client with your mailbox credentials.")}</p>
                <nav aria-label={copy("Email client setup guides")} className="mail-client-links">
                  {CLIENT_GUIDES.map(({ href, label }) => (
                    <Link key={href} href={href}>{copy(label)}<ArrowRight className="size-3.5" aria-hidden="true" /></Link>
                  ))}
                </nav>
              </article>
              <article>
                <FeatureIllustration name="api-sdk" className="marketing-illustration" />
                <h3>{copy("Email from your applications")}</h3>
                <p>{copy("Send transactional mail over SMTP. Automate domains, mailboxes, and server administration through the REST API or MCP.")}</p>
                <div className="mail-client-links">
                  <Link href="/mail/setup-guide/nodemailer">Nodemailer<ArrowRight className="size-3.5" aria-hidden="true" /></Link>
                  <Link href="/docs/api/mail">{copy("Mail API")}<ArrowRight className="size-3.5" aria-hidden="true" /></Link>
                </div>
              </article>
            </div>
          </MarketingSection>

          <MarketingSection
            id="mail-hosting"
            title="Choose where your mail lives."
            description="Run your own mail server or connect mailboxes you already have."
          >
            <div className="mail-hosting-options">
              <article>
                <FeatureIllustration name="server-management" className="marketing-illustration" />
                <h3>{copy("Your own mail server")}</h3>
                <p>{copy("Use Desktop or self-hosted OpenShip to set up mail on a connected server. Your mailboxes and stored messages live there.")}</p>
                <Link href="/docs/guides/email-webmail" className="marketing-text-link">
                  {copy("Set up a mail server")}<ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </article>
              <article>
                <FeatureIllustration name="deploy-anywhere" className="marketing-illustration" />
                <h3>{copy("Webmail on Cloud")}</h3>
                <p>{copy("Host the webmail app on OpenShip Cloud and connect an existing IMAP/SMTP provider. Your provider keeps the mailboxes and handles delivery.")}</p>
                <a href={new URL("/apps/new/webmail", CLOUD_DASHBOARD_URL).toString()} className="marketing-text-link">
                  {copy("Connect existing mail")}<ArrowRight className="size-4" aria-hidden="true" />
                </a>
                <small>{copy("Managed Cloud mailboxes are coming soon.")}</small>
              </article>
            </div>
          </MarketingSection>
        </div>
      </main>
      <Footer />
    </>
  );
}
