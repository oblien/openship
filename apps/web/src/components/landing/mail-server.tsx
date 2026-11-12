import { ArrowRight } from "lucide-react";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Link } from "@/i18n/Link";
import { useCopy } from "@/i18n/use-copy";
import { MAIL_FEATURES } from "@/lib/mail-features";
import { MailPreview } from "@/components/marketing/mail-preview";

export function MailServer() {
  const copy = useCopy();

  return (
    <section id="mail" className="ms-section" aria-labelledby="mail-spotlight-title">
      <div className="site-container ms-grid">
        <div className="ms-lead">
          <p className="ms-eyebrow">OpenShip Mail</p>
          <h2 id="mail-spotlight-title" className="ms-title">
            {copy("Your email.")}
            <br />
            <span>{copy("Your control panel.")}</span>
          </h2>
          <p className="ms-body">
            {copy("Team inboxes and transactional email on your own server. Manage accounts, delivery, and backups alongside your apps.")}
          </p>
          <ul className="ms-capabilities">
            {MAIL_FEATURES.filter(({ id }) => ["accounts", "delivery", "backups"].includes(id)).map((feature) => (
              <li key={feature.id}>
                <FeatureIllustration name={feature.illustration} className="ms-illustration" />
                <span>{copy(feature.title)}</span>
              </li>
            ))}
          </ul>
          <div className="ms-actions">
            <Link href="/mail" className="th-btn rounded-full px-6 py-3 text-[14px]">
              {copy("Explore Mail")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link href="/docs/guides/email-webmail" className="ms-guide">
              {copy("Read the guide")}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          <p className="ms-availability">{copy("Mail server management for Desktop and self-hosted OpenShip.")}</p>
        </div>
        <MailPreview />
      </div>
    </section>
  );
}
