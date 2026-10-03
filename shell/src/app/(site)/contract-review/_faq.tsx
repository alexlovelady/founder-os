import { Section } from "@/components/site/ui";

export interface FaqItem {
  q: string;
  a: string;
}

/**
 * FAQ block shared by the SEO pages (the underscore keeps this file out of routing). Answers are plain strings so the visible text and the
 * FAQPage structured data are always identical. The JSON is escaped as the Next.js JSON-LD guide recommends.
 */
export function Faq({ items }: { items: FaqItem[] }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
  };
  return (
    <Section title="Frequently asked questions">
      <div className="space-y-3">
        {items.map((i) => (
          <details key={i.q} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
            <summary className="cursor-pointer font-medium text-slate-100">{i.q}</summary>
            <p className="mt-2 text-sm text-slate-300">{i.a}</p>
          </details>
        ))}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </Section>
  );
}
