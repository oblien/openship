"use client";

import { useRef, useState } from 'react';
import { useFormatter } from 'next-intl';
import { Link } from '@/i18n/Link';
import { useCopy } from '@/i18n/use-copy';
import type { MailPricing } from '@/lib/pricing';

const modes = [
  { id: 'shared', label: 'Shared mailboxes', shortLabel: 'Shared', description: 'For teams who want email on their own domain. We host the inboxes.' },
  { id: 'dedicated', label: 'Dedicated mailboxes', shortLabel: 'Dedicated', description: 'For teams that want unlimited mailboxes, private storage, and the mail assistant.' },
  { id: 'relay', label: 'API sending only', shortLabel: 'API', description: 'For apps that send receipts, sign-in links, and notifications.' },
] as const;

const features = [
  { group: 'Sending', rows: [
    { name: 'Send from your app via API', available: 'all' },
    { name: 'Send-only keys per domain', available: 'all' },
    { name: 'Track sending usage', available: 'all' },
  ] },
  { group: 'Mailboxes', rows: [
    { name: 'Webmail and IMAP access', available: 'mailboxes' },
    { name: 'Aliases and forwarding', available: 'mailboxes' },
    { name: 'Private mailbox storage', available: 'dedicated' },
    { name: 'AI summaries and reply drafts', available: 'dedicated' },
  ] },
] as const;

export function MailPricingCards({ dashboardUrl, catalog }: { dashboardUrl: string; catalog: MailPricing }) {
  const copy = useCopy();
  const format = useFormatter();
  const [mode, setMode] = useState<(typeof modes)[number]>(modes[0]);
  const [storageIndex, setStorageIndex] = useState(0);
  const storage = catalog.dedicatedStorage[storageIndex] ?? catalog.dedicatedStorage[0]!;
  const dedicatedInput = useRef<HTMLInputElement>(null);
  const money = (value: number) => format.number(value, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const gb = (value: number) => format.number(value, { style: 'unit', unit: 'gigabyte' });
  const dedicated = mode.id === 'dedicated';
  const sendingOnly = mode.id === 'relay';
  const dedicatedStorage = gb(storage.gb);

  return (
    <section id="mail-pricing" aria-labelledby="mail-pricing-title" className="mail-wide-section">
      <header className="text-center">
        <h2 id="mail-pricing-title" className="mail-heading">{copy("OpenShip Mail plans")}</h2>
        <p className="mail-intro">{copy("Choose where your messages live and how much mail you send.")}</p>
      </header>
      <fieldset className="mail-hosting-picker">
        <legend className="sr-only">{copy("OpenShip Mail plans")}</legend>
        {modes.map(option => (
          <label key={option.id}>
            <input type="radio" name="mail-hosting-mode" value={option.id} className="sr-only"
              ref={option.id === 'dedicated' ? dedicatedInput : undefined}
              checked={mode.id === option.id} onChange={() => setMode(option)}
              aria-labelledby={`mail-mode-${option.id}`} aria-describedby={`mail-mode-${option.id}-description`} />
            <span className="mail-hosting-option">
              <strong id={`mail-mode-${option.id}`}>{copy(option.label)}</strong>
              <span id={`mail-mode-${option.id}-description`}>{copy(option.description)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mail-plan-grid">
        {catalog.tiers.map(plan => {
          const { id, name } = plan;
          const checkoutPlan = mode.id === 'shared' ? plan.checkoutPlan : null;
          let priceCents = plan.monthlyCents;
          if (sendingOnly) priceCents = plan.sendingMonthlyCents;
          if (dedicated) priceCents = storage.monthlyCents + plan.sendingMonthlyCents;
          const displayPrice = money(priceCents / 100);
          const facts = [
            { label: copy("Monthly recipients"), value: format.number(plan.recipients) },
            { label: copy("Domains"), value: format.number(plan.domains) },
          ];
          if (sendingOnly) {
            facts.push(
              { label: copy("API keys"), value: copy("Per domain") },
              { label: copy("Track sending usage"), value: copy("Included") },
            );
          } else {
            facts.push(
              { label: copy("Mailboxes"), value: dedicated ? copy("Unlimited") : format.number(plan.mailboxes) },
              { label: copy("Storage"), value: dedicated ? dedicatedStorage : gb(plan.storageMB / 1024) },
            );
          }
          const configuration = [copy("OpenShip Mail"), name, copy(mode.label), displayPrice + ' ' + copy("/mo estimated"),
            ...facts.map(fact => fact.label + ' · ' + fact.value)].join('\n');
          const href = checkoutPlan
            ? dashboardUrl + '?' + new URLSearchParams({ mailPlan: checkoutPlan }) + '#email-plans'
            : '/contact?' + new URLSearchParams({ topic: 'mail', configuration }) + '#contact-name';
          return (
            <article key={id} className="mail-plan-card" data-tier={id} aria-labelledby={'mail-plan-' + id}>
              <h3 className="mail-plan-name" id={'mail-plan-' + id}>{name}</h3>
              <p className="mail-tier-description">{plan.description}</p>
              <p className="mail-plan-price">
                <strong><bdi>{displayPrice}</bdi></strong>
                <span>{checkoutPlan ? copy("/mo") : copy("/mo estimated")}</span>
              </p>
              <dl>{facts.map(({ label, value }) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}</dl>
              <Link href={href} prefetch={false} className="mail-plan-action">
                {checkoutPlan ? copy("Choose {name}", { name }) : copy("Request a quote")}
              </Link>
            </article>
          );
        })}
      </div>
      <div className="mail-plan-tools">
        {dedicated ? (
          <>
            <label htmlFor="mail-plan-storage">{copy("Mailbox storage")}</label>
            <div className="mail-storage-range">
              <input id="mail-plan-storage" type="range" min={0} max={catalog.dedicatedStorage.length - 1} step={1}
                value={storageIndex} aria-valuetext={dedicatedStorage}
                onChange={event => setStorageIndex(event.currentTarget.valueAsNumber)} />
              <span aria-hidden="true">{dedicatedStorage}</span>
            </div>
          </>
        ) : (
          <>
            <span>{copy("Need more mailboxes?")}</span>
            <button type="button" onClick={() => {
              dedicatedInput.current?.click();
              dedicatedInput.current?.focus({ preventScroll: true });
              dedicatedInput.current?.closest('fieldset')?.scrollIntoView({ block: 'center' });
            }}>{copy("Compare dedicated plans")}</button>
          </>
        )}
      </div>
      <p className="mail-pricing-note">{copy("Sample monthly prices in USD.")} {copy("Eligible paid compute plans already include a mailbox.")} <a href={dashboardUrl + '#email-plans'}>{copy("View dashboard plans")}</a></p>
      <table className="mail-feature-comparison">
        <caption>{copy("Compare features")}</caption>
        <thead>
          <tr>
            <td />
            {modes.map(option => <th key={option.id} scope="col" data-selected={option.id === mode.id || undefined}>
              {copy(option.shortLabel)}
            </th>)}
          </tr>
        </thead>
        {features.map(group => (
          <tbody key={group.group}>
            <tr><th colSpan={4} scope="rowgroup">{copy(group.group)}</th></tr>
            {group.rows.map(feature => (
              <tr key={feature.name}>
                <th scope="row">{copy(feature.name)}</th>
                {modes.map(option => {
                  const included = feature.available === 'all' || option.id === 'dedicated' ||
                    (feature.available === 'mailboxes' && option.id === 'shared');
                  return <td key={option.id} data-selected={option.id === mode.id || undefined}>
                    <span aria-hidden="true" className={included ? 'mail-feature-yes' : 'mail-feature-no'}>{included ? '✓' : '–'}</span>
                    <span className="sr-only">{included ? copy("Included") : copy("Not included")}</span>
                  </td>;
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </section>
  );
}
