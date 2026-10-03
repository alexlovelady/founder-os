/**
 * Deterministic fill-in-the-blank drafts for every marketing kind. No AI, no network, no invented facts: the only facts in the output are
 * the ones the owner typed. Anything not provided becomes a [●PLACEHOLDER] to fill in by hand.
 */
import { TONES, type ItemKind, type Tone } from "./prompts";

export type TemplateTone = (typeof TONES)[number] | "neutral";
export const TEMPLATE_TONES: readonly TemplateTone[] = ["neutral", ...TONES];

export interface TemplateInput {
  kind: ItemKind;
  businessName?: string;
  /** What is being offered or promoted. */
  offer?: string;
  audience?: string;
  tone?: TemplateTone;
  /** One point per line (or separated by semicolons). */
  keyPoints?: string;
  cta?: string;
  channel?: string;
  /** Town or area, used by SEO ideas. */
  location?: string;
  reviewText?: string;
  rating?: string;
  weeks?: number;
  senderName?: string;
}

export const TEMPLATE_LABEL = "Template draft, fill in the [●PLACEHOLDERS] and review before use";

/** The strongest tone slider at 65 or more, otherwise neutral. */
export function toneFromBrand(tone: Tone): TemplateTone {
  let best: TemplateTone = "neutral";
  let score = 64;
  for (const t of TONES) if ((tone[t] ?? 50) > score) { best = t; score = tone[t]; }
  return best;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const ph = (label: string) => `[●${label.toUpperCase()}]`;
const or = (v: string | undefined, label: string) => clean(v) || ph(label);
const stripEnd = (s: string) => s.replace(/[\s.!?;:,]+$/, "");
const sentence = (s: string) => (/[.!?]$/.test(s) || /\]$/.test(s) ? s : `${s}.`);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function splitPoints(s: string | undefined): string[] {
  return (s ?? "").split(/\n|;/).map((p) => clean(p).replace(/^[-*•\d.)\s]+(?=\S)/, "")).filter(Boolean).slice(0, 8);
}
/** The i-th key point, or a numbered placeholder. */
const point = (pts: string[], i: number) => pts[i] ?? ph(`KEY POINT ${i + 1}`);

interface Voice { open: (audience: string) => string; close: string; emphasis: (s: string) => string; sign: string }
const VOICE: Record<TemplateTone, Voice> = {
  neutral: { open: () => "Hello,", close: "Thank you,", emphasis: (s) => s, sign: "Best regards," },
  formal: { open: (a) => `Dear ${a},`, close: "We would be glad to hear from you.", emphasis: (s) => s, sign: "Kind regards," },
  playful: { open: () => "Hey there!", close: "Can't wait to hear from you!", emphasis: (s) => `${s}!`, sign: "Cheers," },
  bold: { open: () => "Here is the deal.", close: "Do not wait on this one.", emphasis: (s) => `${s}.`, sign: "Talk soon," },
  warm: { open: () => "Hi there,", close: "We would love to hear from you.", emphasis: (s) => s, sign: "Warmly," },
};

/** Greedily joins parts while the result stays within `max` characters. */
function fit(parts: string[], max: number): string {
  let out = "";
  for (const p of parts) {
    const next = out ? `${out} ${p}` : p;
    if (next.length > max) break;
    out = next;
  }
  return out;
}
const firstThatFits = (cands: string[], max: number, fallback: string) => cands.find((c) => c.length <= max) ?? fallback;

interface Ctx { name: string; offer: string; audience: string; pts: string[]; cta: string; channel: string; v: Voice; tone: TemplateTone }
function ctxOf(i: TemplateInput): Ctx {
  const tone = i.tone ?? "neutral";
  return {
    name: clean(i.businessName) || ph("BUSINESS NAME"),
    offer: or(i.offer, "OFFER"),
    audience: or(i.audience, "AUDIENCE"),
    pts: splitPoints(i.keyPoints),
    cta: stripEnd(or(i.cta, "CALL TO ACTION")),
    channel: clean(i.channel),
    v: VOICE[tone],
    tone,
  };
}

const socialPost = (c: Ctx): string => {
  const ch = c.channel ? ` (${c.channel})` : "";
  const hook = c.tone === "playful" ? `Guess what, ${c.audience}?` : c.tone === "bold" ? `${cap(c.audience)}, listen up.` : `For ${c.audience}:`;
  return [
    `Option 1${ch}`, `${hook} ${sentence(c.v.emphasis(c.offer))} ${sentence(point(c.pts, 0))} ${sentence(c.cta)}`, "",
    `Option 2${ch}`, `${c.name} here. ${sentence(cap(point(c.pts, 0)))} ${sentence(cap(point(c.pts, 1)))} ${sentence(c.cta)}`, "",
    `Option 3${ch}`, `${sentence(cap(c.offer))} Made for ${c.audience}. ${sentence(c.v.close)} ${sentence(c.cta)}`,
  ].join("\n");
};

const email = (c: Ctx, i: TemplateInput): string => {
  const bullets = [0, 1, 2].map((n) => `- ${cap(point(c.pts, n))}`);
  return [
    `Subject: ${cap(c.offer)}`,
    `Preview: ${fit([`For ${c.audience}.`, sentence(cap(point(c.pts, 0)))], 90)}`,
    "",
    c.v.open(c.audience),
    "",
    `We wanted to tell you about ${c.offer}. It is meant for ${c.audience}.`,
    "",
    ...bullets,
    "",
    sentence(`${cap(c.cta)}`),
    "",
    c.v.close,
    "",
    c.v.sign,
    or(i.senderName, "SENDER NAME"),
    c.name,
  ].join("\n");
};

const landingCopy = (c: Ctx): string => [
  `HEADLINE\n${cap(c.offer)}`,
  `SUBHEADLINE\nFor ${c.audience}. ${sentence(cap(point(c.pts, 0)))}`,
  `BENEFITS\n1. ${cap(point(c.pts, 0))}\n2. ${cap(point(c.pts, 1))}\n3. ${cap(point(c.pts, 2))}`,
  `HOW IT WORKS\n1. Get in touch: ${ph("HOW TO CONTACT YOU")}\n2. We talk through what you need: ${ph("WHAT HAPPENS NEXT")}\n3. ${ph("FINAL STEP")}`,
  `WHAT CUSTOMERS SAY\n${ph("CUSTOMER QUOTE")} ${ph("CUSTOMER NAME")}`,
  `CALL TO ACTION\n${cap(c.cta)}`,
].join("\n\n");

const adCopy = (c: Ctx): string => {
  const variants = [
    { h: [c.offer, cap(c.offer)], d: [sentence(cap(c.offer)), `For ${c.audience}.`, sentence(cap(c.cta))] },
    { h: [`For ${c.audience}`, cap(c.audience)], d: [sentence(cap(point(c.pts, 0))), sentence(cap(point(c.pts, 1))), sentence(cap(c.cta))] },
    { h: [cap(c.cta), c.name], d: [sentence(`${cap(c.name)}: ${c.offer}`), sentence(cap(c.cta))] },
  ];
  const ch = c.channel ? ` for ${c.channel}` : "";
  return variants.map((v, n) => [
    `Variant ${n + 1}${ch}`,
    `Headline: ${firstThatFits(v.h, 30, ph("HEADLINE, 30 CHARACTERS MAX"))}`,
    `Description: ${fit(v.d, 90) || ph("DESCRIPTION, 90 CHARACTERS MAX")}`,
    `Call to action: ${stripEnd(c.cta)}`,
  ].join("\n")).join("\n\n");
};

const reviewReply = (c: Ctx, i: TemplateInput): string => {
  const stars = Number.parseFloat(clean(i.rating));
  const negative = Number.isFinite(stars) && stars <= 3;
  const detail = clean(i.reviewText);
  const lines = negative
    ? [
        `Hello ${ph("CUSTOMER NAME")},`,
        "",
        `Thank you for telling us about this. We are sorry your experience with ${c.name} was not what you expected.`,
        `You mentioned ${ph("SPECIFIC THING THEY MENTIONED")}. We take that seriously.`,
        `We would like to talk with you directly and see what we can do. ${sentence(cap(c.cta === ph("CALL TO ACTION") ? ph("HOW TO REACH YOU") : c.cta))}`,
        "",
        `${c.v.sign.replace(/,$/, "")},`,
        `${or(i.senderName, "NAME")}, ${c.name}`,
      ]
    : [
        `Hello ${ph("CUSTOMER NAME")},`,
        "",
        `Thank you for taking the time to review ${c.name}. We really appreciate it.`,
        `We were glad to hear about ${ph("SPECIFIC THING THEY MENTIONED")}.`,
        sentence(cap(c.cta === ph("CALL TO ACTION") ? "We hope to see you again" : c.cta)),
        "",
        c.v.sign,
        `${or(i.senderName, "NAME")}, ${c.name}`,
      ];
  return `${detail ? `Replying to: "${detail.slice(0, 200)}"\n\n` : ""}${lines.join("\n")}`;
};

const blogOutline = (c: Ctx): string => [
  "TITLE OPTIONS",
  `1. ${cap(c.offer)}: what ${c.audience} should know`,
  `2. Questions to ask before you choose ${c.offer}`,
  `3. A plain guide to ${c.offer}`,
  "",
  `HOOK\nIf you are ${c.audience}, here is what matters about ${c.offer}. ${ph("YOUR OPENING STORY OR QUESTION")}`,
  "",
  `## What it is\n- Explain ${c.offer} in two plain sentences\n- ${ph("WHO IT IS FOR AND WHO IT IS NOT FOR")}`,
  ...[0, 1, 2].map((n) => `\n## ${cap(point(c.pts, n))}\n- What it means for ${c.audience}\n- An example from your own work: ${ph("YOUR EXAMPLE")}\n- ${ph("SOURCE NEEDED")} (add one only if you state a statistic)`),
  `\n## What to do next\n- ${cap(c.cta)}`,
].join("\n");

const DAYS = ["Monday", "Wednesday", "Friday"];
const FORMATS = ["short post", "photo with caption", "short video or story", "question to your audience"];
const contentCalendar = (c: Ctx, i: TemplateInput): string => {
  const weeks = Math.min(12, Math.max(1, Math.round(i.weeks ?? 4)));
  const channel = c.channel || ph("CHANNEL");
  const out: string[] = [];
  let n = 0;
  for (let w = 1; w <= weeks; w++) {
    out.push(`Week ${w}`);
    for (const day of DAYS) {
      const topic = c.pts.length ? c.pts[n % c.pts.length] : `${c.offer}: ${ph(`TOPIC ${n + 1}`)}`;
      out.push(`- ${day}, ${channel}, ${topic}, ${FORMATS[n % FORMATS.length]}`);
      n++;
    }
    out.push("");
  }
  return out.join("\n").trim();
};

const seoIdeas = (c: Ctx, i: TemplateInput): string => {
  const place = clean(i.location) || ph("TOWN OR AREA");
  return [
    "SEARCH PHRASES (intent in brackets)",
    `1. ${c.offer} near ${place} [buy]`,
    `2. ${c.offer} for ${c.audience} [buy]`,
    `3. how does ${c.offer} work [learn]`,
    `4. questions to ask about ${c.offer} [learn]`,
    `5. ${c.offer} cost [compare]`,
    `6. ${c.offer} vs ${ph("ALTERNATIVE")} [compare]`,
    `7. ${c.offer} in ${place} [buy]`,
    `8. ${cap(point(c.pts, 0))} [learn]`,
    `9. ${cap(point(c.pts, 1))} [learn]`,
    `10. reviews of ${c.offer} ${place} [compare]`,
    "",
    "PAGE OR BLOG IDEAS",
    `1. A page about ${c.offer} for ${c.audience}`,
    `2. A plain guide: how ${c.offer} works`,
    `3. Frequently asked questions about ${c.offer}`,
    `4. ${cap(point(c.pts, 0))}: explained`,
    `5. ${ph("A CUSTOMER STORY YOU CAN SHARE")}`,
    "",
    "LOCAL IDEAS",
    `1. Make sure your Google Business Profile lists ${c.offer} and ${place}`,
    `2. A page for ${place} with your address and hours: ${ph("ADDRESS AND HOURS")}`,
    `3. Ask happy customers for a review: ${ph("REVIEW LINK")}`,
    "",
    "This list has no search volumes or rankings: this tool has no data on them.",
  ].join("\n");
};

/** Renders the draft for one kind. Pure and deterministic. */
export function renderTemplate(i: TemplateInput): string {
  const c = ctxOf(i);
  switch (i.kind) {
    case "social_post": return socialPost(c);
    case "email": return email(c, i);
    case "landing_copy": return landingCopy(c);
    case "ad_copy": return adCopy(c);
    case "review_reply": return reviewReply(c, i);
    case "blog_outline": return blogOutline(c);
    case "content_calendar": return contentCalendar(c, i);
    case "seo_ideas": return seoIdeas(c, i);
  }
}

/** Everything the owner typed, for the fabricated-claim guard (a template can only repeat these). */
export function templateSources(i: TemplateInput): string {
  return [i.businessName, i.offer, i.audience, i.keyPoints, i.cta, i.channel, i.location, i.reviewText, i.rating, i.senderName].filter(Boolean).join("\n");
}
