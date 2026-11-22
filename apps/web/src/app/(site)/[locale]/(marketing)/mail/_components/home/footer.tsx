import { Link } from '@/i18n/Link';
import { useCopy } from '@/i18n/use-copy';
import { Discord, GitHub, Twitter } from '../icons';

const social = [
  { name: 'GitHub', href: 'https://github.com/oblien/openship', Icon: GitHub },
  { name: 'X', href: 'https://x.com/openshipio', Icon: Twitter },
  { name: 'Discord', href: 'https://discord.gg/Q9eWNCeXjg', Icon: Discord },
];

export default function MailFooter() {
  const copy = useCopy();
  return (
    <footer className="mail-footer">
      <img src="/gradient.svg" alt="" loading="lazy" width={1408} height={587} className="block h-auto w-full" />
      <div className="mail-footer-invite">
        <h2 className="mail-footer-title">{copy("Experience the Future of")}<br />{copy("Email Today")}</h2>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-5">
          <Link href="/docs/guides/email-webmail" className="mail-primary-link">{copy("Use my server")}</Link>
          <a href="#mail-pricing" className="mail-inline-link text-sm">{copy("View email plans")}</a>
        </div>
      </div>
      <div className="mail-footer-links">
        <div>
          <Link href="/mail" className="inline-flex items-center gap-3 text-xl font-medium">
            <span aria-hidden="true" className="mail-footer-mark size-8 rounded-full border-[3px]" />{copy("OpenShip Mail")}
          </Link>
          <div className="mt-4 flex gap-2">
            {social.map(({ name, href, Icon }) => (
              <a key={name} href={href} aria-label={name} className="grid size-9 place-items-center rounded-full bg-white/10 hover:bg-white/20">
                <Icon className="size-4 fill-current" />
              </a>
            ))}
          </div>
        </div>
        <div>
          <h3>{copy("Resources")}</h3>
          <a href="#setup-guides">{copy("Setup guides")}</a>
          <Link href="/docs/api/mail">{copy("Mail API")}</Link>
          <Link href="/support">{copy("Support")}</Link>
        </div>
        <div>
          <h3>{copy("OpenShip")}</h3>
          <Link href="/about">{copy("About")}</Link>
          <Link href="/changelog">{copy("Changelog")}</Link>
          <Link href="/contact">{copy("Contact")}</Link>
        </div>
        <div className="mail-footer-legal">
          <span>{copy("© {year} Oblien LLC. All rights reserved.", { year: new Date().getUTCFullYear() })}</span>
          <Link href="/terms">{copy("Terms")}</Link><Link href="/privacy">{copy("Privacy")}</Link>
        </div>
      </div>
    </footer>
  );
}
