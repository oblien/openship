import Image from 'next/image';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/Link';
import { useCopy } from '@/i18n/use-copy';
import { MAIL_FEATURES } from '@/lib/mail-features';
import { ArrowRight, Bell, Folder, GroupPeople, LockIcon, Mail, Tag } from '../icons';

const guideIcons: Record<string, typeof Mail> = { accounts: GroupPeople, aliases: Tag, delivery: Mail, health: LockIcon, backups: Folder, notifications: Bell };

export function MailHosting() {
  const copy = useCopy();
  return (
    <section id="mail-hosting" aria-labelledby="mail-hosting-title" className="mail-showcase-width mt-16 grid scroll-mt-24 items-center gap-8 md:mt-24 md:grid-cols-2 lg:gap-12">
      <div>
        <h2 id="mail-hosting-title" className="mail-heading mail-delivery-title">
          {copy("Your inbox on your server.")}
          <span className="block text-white/45">{copy("Send with OpenShip.")}</span>
        </h2>
        <p className="mt-4 max-w-md text-pretty leading-relaxed text-[#b7b7b7]">
          {copy("Keep messages and attachments on your hardware. OpenShip’s relay delivers outgoing mail from your verified domain.")}
        </p>
        <Link href="/docs/guides/email-webmail" className="mail-primary-link mt-6">{copy("Set up a mail server")}</Link>
      </div>
      <Image
        src="/compose.png"
        width={4354}
        height={2716}
        sizes="(min-width: 1282px) 601px, (min-width: 768px) 48vw, 96vw"
        alt={copy("Draft a reply")}
        className="block h-auto w-full"
      />
    </section>
  );
}

export function MailAdministration() {
  const copy = useCopy();
  const locale = useLocale();
  return (
    <section id="control-panel" aria-labelledby="control-panel-title" className="mail-wide-section mail-admin">
      <div className="mail-admin-copy">
        <h2 id="control-panel-title" className="mail-heading mail-delivery-title">{copy("Your team’s mail, in one place.")}</h2>
        <p className="mt-4 max-w-md leading-relaxed text-[#b7b7b7]">{copy("Add an address, forward mail to a teammate, or back up your mail server.")}</p>
      </div>
      <div className="mail-admin-preview">
        <Image
          src={`/screenshots/${locale}/mail-control-panel-dark.webp`}
          alt={copy("OpenShip Mail control panel showing mailbox accounts, quotas, and administration tabs.")}
          width={2400}
          height={1520}
          sizes="(min-width: 1280px) 720px, (min-width: 960px) 56vw, 94vw"
          className="block h-auto w-full rounded-lg"
        />
      </div>
      <ul className="mail-admin-guides">
        {MAIL_FEATURES.map(({ id, title, href }) => {
          const Icon = guideIcons[id] ?? Mail;
          return (
            <li key={id}><Link href={href} className="group flex h-full items-center gap-2.5 rounded-lg px-2.5 py-3 text-sm hover:bg-white/5">
              <Icon className="size-4 shrink-0 fill-[#aaa]" />
              <span>{copy(title)}</span><ArrowRight className="ms-auto hidden size-3 shrink-0 opacity-45 group-hover:opacity-100 sm:block rtl:rotate-180" />
            </Link></li>
          );
        })}
      </ul>
    </section>
  );
}
