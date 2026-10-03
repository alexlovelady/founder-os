export const KINDS = ["social_post", "email", "landing_copy", "ad_copy", "review_reply", "blog_outline", "content_calendar", "seo_ideas"] as const;
export type ItemKind = (typeof KINDS)[number];
export const KIND_LABEL: Record<ItemKind, string> = {
  social_post: "Social post", email: "Email", landing_copy: "Landing page copy", ad_copy: "Ad copy", review_reply: "Review reply",
  blog_outline: "Blog outline", content_calendar: "Content calendar", seo_ideas: "SEO ideas",
};

export const TONES = ["formal", "playful", "bold", "warm"] as const;
export type Tone = Record<(typeof TONES)[number], number>;
export const DEFAULT_TONE: Tone = { formal: 50, playful: 50, bold: 50, warm: 50 };
const TONE_WORDS: Record<keyof Tone, [string, string]> = { formal: ["very casual", "very formal"], playful: ["serious", "playful"], bold: ["reserved", "bold"], warm: ["matter-of-fact", "warm and personal"] };

export interface Brand { voice: string; audience: string; offers: string; doWords: string; dontWords: string; tone: Tone }
export const EMPTY_BRAND: Brand = { voice: "", audience: "", offers: "", doWords: "", dontWords: "", tone: DEFAULT_TONE };

export const SYSTEM = `You are a copywriter for a small business. You write in the business's own voice, never generic marketing filler.
Hard rules:
- Use ONLY facts given in the business description, brand profile and the owner's request.
- NEVER invent customer testimonials, reviews, statistics, percentages, prices, discounts, awards, years in business, customer counts, or guarantees. Where such a fact would help but was not supplied, write [●PLACEHOLDER] with a short hint, e.g. [●PRICE] or [●CUSTOMER QUOTE].
- Do not promise results. No claims about rankings, reach or performance.
- Respect the do and don't words and the tone settings.
- Output ONLY the finished copy. No introduction, no explanation, no closing remarks, no code fences.`;

export function brandText(b: Brand): string {
  const tone = (Object.keys(TONE_WORDS) as (keyof Tone)[]).map((k) => {
    const v = b.tone[k] ?? 50;
    const [lo, hi] = TONE_WORDS[k];
    return v <= 35 ? `leaning ${lo}` : v >= 65 ? `leaning ${hi}` : `balanced between ${lo} and ${hi}`;
  }).join("; ");
  return [
    `Voice: ${b.voice || "not set"}`, `Audience: ${b.audience || "not set"}`, `Offers: ${b.offers || "not set"}`,
    `Words to use: ${b.doWords || "none given"}`, `Words to avoid: ${b.dontWords || "none given"}`, `Tone: ${tone}`,
  ].join("\n");
}

export interface GenInput { kind: ItemKind; topic: string; channel?: string; details?: string; reviewText?: string; rating?: string; weeks?: number }

export function userSources(i: GenInput): string {
  return [i.topic, i.channel, i.details, i.reviewText, i.rating].filter(Boolean).join("\n");
}

const TASK: Record<ItemKind, (i: GenInput) => string> = {
  social_post: (i) => `Write 3 alternative social media posts for ${i.channel || "the channel the owner uses"} about: ${i.topic}. Label them Option 1-3. Add a short call to action. Hashtags only if natural for the channel.`,
  email: (i) => `Write an email about: ${i.topic}. Give "Subject:" and "Preview:" lines first, then the body, then a sign-off with [●SENDER NAME].`,
  landing_copy: (i) => `Write landing page copy about: ${i.topic}. Sections: headline, subheadline, 3 short benefit blocks, how it works in 3 steps, call to action. Do not add testimonials unless supplied; leave a [●CUSTOMER QUOTE] slot.`,
  ad_copy: (i) => `Write ad copy for ${i.channel || "a search or social ad"} about: ${i.topic}. Give 3 variants, each with headline (max 30 chars), description (max 90 chars) and a call to action.`,
  review_reply: (i) => `Reply on behalf of the business to this customer review${i.rating ? ` (${i.rating} stars)` : ""}. Be sincere and brief, thank them, address specifics, and for negative reviews offer to make it right offline without admitting legal liability. Do not invent facts about what happened.\n\nREVIEW:\n${i.reviewText ?? i.topic}`,
  blog_outline: (i) => `Write a blog post outline about: ${i.topic}. Give 3 title options, a one-line hook, H2 sections with bullet points, and a closing call to action. Do not add statistics unless supplied; mark spots needing a source as [●SOURCE NEEDED].`,
  content_calendar: (i) => `Plan a ${i.weeks ?? 4}-week content calendar for ${i.channel || "the business's channels"} about: ${i.topic}. Format as a markdown list grouped by "Week N", one line per post: day, channel, topic, format. Do not include real dates.`,
  seo_ideas: (i) => `Suggest SEO ideas for: ${i.topic}. Give 10 search phrases real customers might use (with intent: learn, compare or buy), 5 page or blog ideas, and 3 local or Google Business Profile ideas if relevant. Do not state search volumes or rankings; you have no data.`,
};

export function buildGenerationPrompt(businessText: string, brand: Brand, i: GenInput): string {
  return `ABOUT THE BUSINESS\n${businessText}\n\nBRAND PROFILE\n${brandText(brand)}\n\nTASK\n${TASK[i.kind](i)}${i.details ? `\n\nOWNER'S EXTRA DETAILS (facts you may use)\n${i.details}` : ""}`;
}

export function buildBrandPrompt(businessText: string, notes: string): string {
  return `ABOUT THE BUSINESS\n${businessText}\n\nTASK\nPropose a brand voice profile for this business, based only on the information above${notes ? ` and these owner notes: ${notes}` : ""}. Where the information is not enough, write [●PLACEHOLDER] with a hint. Reply in exactly these five labelled lines and nothing else:\nVOICE: one or two sentences describing how the business sounds\nAUDIENCE: who it talks to\nOFFERS: what it sells or offers, as named in the information above\nDO: comma-separated words or phrases to use\nDONT: comma-separated words or phrases to avoid`;
}

/** Strip chatter and code fences around model output. */
export function cleanAiText(text: string): string {
  let t = text.replace(/\r\n?/g, "\n").trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  const lines = t.split("\n");
  while (lines.length && /^(sure|certainly|of course|here(?:'s| is| are)|absolutely)\b.*(:|!|\.)\s*$/i.test(lines[0].trim()) && lines[0].length < 120) { lines.shift(); while (lines.length && !lines[0].trim()) lines.shift(); }
  while (lines.length && /^(let me know|i hope this|feel free|would you like|hope this helps)/i.test(lines[lines.length - 1].trim())) lines.pop();
  while (lines.length && /^---+\s*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join("\n").trim();
}

export function parseBrandSuggestion(text: string): Partial<Omit<Brand, "tone">> {
  const get = (label: string) => new RegExp(`^\\s*\\**${label}\\**\\s*:\\s*(.+)$`, "im").exec(text)?.[1]?.trim();
  const out: Partial<Omit<Brand, "tone">> = {};
  const m = { voice: get("VOICE"), audience: get("AUDIENCE"), offers: get("OFFERS"), doWords: get("DO"), dontWords: get("DONT") };
  for (const [k, v] of Object.entries(m)) if (v) (out as Record<string, string>)[k] = v;
  return out;
}
