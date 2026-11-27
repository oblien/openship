"use client";

import { useCopy } from "@/i18n/use-copy";
import type { MailProduct } from "@repo/core/managed-mail";
import type { MailPricing } from "@/lib/pricing";

const modes = [
  { id: "mailboxes", featureKey: "shared", shortLabel: "Shared" },
  { id: "dedicated", featureKey: "dedicated", shortLabel: "Dedicated" },
  { id: "sending", featureKey: "relay", shortLabel: "API" },
] as const;

const features = [
  {
    group: "Sending",
    rows: [
      { id: "sending-api", name: "Send from your app via API" },
      { id: "domain-keys", name: "Send-only keys per domain" },
      { id: "sending-usage", name: "Track sending usage" },
    ],
  },
  {
    group: "Mailboxes",
    rows: [
      { id: "webmail-imap", name: "Webmail and IMAP access" },
      { id: "aliases", name: "Aliases and forwarding" },
      { id: "private-storage", name: "Private mailbox storage" },
      { id: "mail-assistant", name: "AI summaries and reply drafts" },
    ],
  },
] as const;

export function MailFeatureComparison({
  mode,
  includedFeatures,
}: {
  mode: MailProduct;
  includedFeatures: MailPricing["features"];
}) {
  const copy = useCopy();
  return (
    <table className="mail-feature-comparison">
      <caption>{copy("Compare features")}</caption>
      <thead>
        <tr>
          <td />
          {modes.map((option) => (
            <th key={option.id} scope="col" data-selected={option.id === mode || undefined}>
              {copy(option.shortLabel)}
            </th>
          ))}
        </tr>
      </thead>
      {features.map((group) => (
        <tbody key={group.group}>
          <tr>
            <th colSpan={4} scope="rowgroup">
              {copy(group.group)}
            </th>
          </tr>
          {group.rows.map((feature) => (
            <tr key={feature.name}>
              <th scope="row">{copy(feature.name)}</th>
              {modes.map((option) => {
                const included = includedFeatures[option.featureKey].includes(feature.id);
                return (
                  <td key={option.id} data-selected={option.id === mode || undefined}>
                    <span
                      aria-hidden="true"
                      className={included ? "mail-feature-yes" : "mail-feature-no"}
                    >
                      {included ? "✓" : "–"}
                    </span>
                    <span className="sr-only">
                      {included ? copy("Included") : copy("Not included")}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
