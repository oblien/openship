import { useCopy } from "@/i18n/use-copy";

import { Plus } from "lucide-react";

/** Render only the questions shown on this page in its structured data. */
export function MigrationFaq({ items }: { items: { q: string; a: string }[] }) {
  const copy = useCopy();

  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
  return (
    <div className="mg-faq">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
      />
      {items.map((item) => (
        <details key={item.q}>
          <summary>
            {copy(item.q)}
            <Plus size={16} aria-hidden="true" />
          </summary>
          <p>{copy(item.a)}</p>
        </details>
      ))}
    </div>
  );
}
