/**
 * A tiny, safe markdown subset. It parses to a data structure (never to raw HTML), so the UI renders it as React elements and the
 * export path escapes everything. Supported: # headings, paragraphs, - / 1. lists, - [ ] task lists, > quotes, --- rules, ``` code,
 * **bold**, *italic*, `code`, [text](https://link).
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "b"; v: string }
  | { t: "i"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string };

export type Block =
  | { t: "h"; level: number; inl: Inline[] }
  | { t: "p"; inl: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "task"; items: { done: boolean; inl: Inline[] }[] }
  | { t: "quote"; inl: Inline[] }
  | { t: "hr" }
  | { t: "code"; v: string };

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/))/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: "b", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "i", v: m[3] });
    else if (m[4] !== undefined) out.push({ t: "code", v: m[4] });
    else if (SAFE_HREF.test(m[6])) out.push({ t: "link", v: m[5], href: m[6] });
    else out.push({ t: "text", v: m[5] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const isSpecial = (l: string) => /^(#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|>\s?|---+\s*$|```)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push({ t: "code", v: buf.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: "h", level: h[1].length, inl: parseInline(h[2].trim()) }); i++; continue; }
    if (/^---+\s*$/.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ t: "quote", inl: parseInline(buf.join(" ")) });
      continue;
    }
    if (/^\s*[-*]\s+\[[ xX]\]\s/.test(line)) {
      const items: { done: boolean; inl: Inline[] }[] = [];
      while (i < lines.length) {
        const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push({ done: m[1] !== " ", inl: parseInline(m[2]) });
        i++;
      }
      blocks.push({ t: "task", items });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]) && !/^\s*[-*]\s+\[[ xX]\]\s/.test(lines[i])) items.push(parseInline(lines[i++].replace(/^\s*[-*]\s+/, "")));
      blocks.push({ t: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(parseInline(lines[i++].replace(/^\s*\d+[.)]\s+/, "")));
      blocks.push({ t: "ol", items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !(buf.length > 0 && isSpecial(lines[i]))) buf.push(lines[i++].trim());
    blocks.push({ t: "p", inl: parseInline(buf.join(" ")) });
  }
  return blocks;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const inlHtml = (inl: Inline[]) =>
  inl
    .map((n) => {
      if (n.t === "text") return escapeHtml(n.v);
      if (n.t === "b") return `<strong>${escapeHtml(n.v)}</strong>`;
      if (n.t === "i") return `<em>${escapeHtml(n.v)}</em>`;
      if (n.t === "code") return `<code>${escapeHtml(n.v)}</code>`;
      return `<a href="${escapeHtml(n.href)}">${escapeHtml(n.v)}</a>`;
    })
    .join("");

/** Fully escaped HTML for print and Word export. */
export function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "h": return `<h${b.level}>${inlHtml(b.inl)}</h${b.level}>`;
        case "p": return `<p>${inlHtml(b.inl)}</p>`;
        case "ul": return `<ul>${b.items.map((x) => `<li>${inlHtml(x)}</li>`).join("")}</ul>`;
        case "ol": return `<ol>${b.items.map((x) => `<li>${inlHtml(x)}</li>`).join("")}</ol>`;
        case "task": return `<ul style="list-style:none;padding-left:0">${b.items.map((x) => `<li>${x.done ? "&#9745;" : "&#9744;"} ${inlHtml(x.inl)}</li>`).join("")}</ul>`;
        case "quote": return `<blockquote>${inlHtml(b.inl)}</blockquote>`;
        case "hr": return "<hr/>";
        case "code": return `<pre>${escapeHtml(b.v)}</pre>`;
      }
    })
    .join("\n");
}

export function exportHtml(title: string, markdown: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Calibri,Arial,sans-serif;max-width:760px;margin:2rem auto;line-height:1.5;color:#111}h1,h2,h3{margin:1.2em 0 .4em}pre{background:#f3f4f6;padding:.6rem}blockquote{border-left:3px solid #999;margin-left:0;padding-left:1rem;color:#444}</style></head><body>${blocksToHtml(parseMarkdown(markdown))}</body></html>`;
}

const plain = (inl: Inline[]) => inl.map((n) => n.v).join("");

/** The steps of a process: the Procedure section if there is one, otherwise every list item in the document. */
export function extractSteps(markdown: string): string[] {
  const blocks = parseMarkdown(markdown);
  const items = (b: Block): string[] => (b.t === "ol" || b.t === "ul" ? b.items.map(plain) : b.t === "task" ? b.items.map((x) => plain(x.inl)) : []);
  const idx = blocks.findIndex((b) => b.t === "h" && /^(procedure|steps)\b/i.test(plain(b.inl)));
  if (idx >= 0) {
    const out: string[] = [];
    for (let j = idx + 1; j < blocks.length; j++) {
      const b = blocks[j];
      if (b.t === "h" && b.level <= (blocks[idx] as { level: number }).level) break;
      out.push(...items(b));
    }
    if (out.length) return out.map((s) => s.trim()).filter(Boolean);
  }
  return blocks.flatMap(items).map((s) => s.trim()).filter(Boolean);
}

export function toChecklist(title: string, markdown: string): string {
  const steps = extractSteps(markdown);
  return `# Checklist: ${title}\n\n${steps.map((s) => `- [ ] ${s}`).join("\n")}\n`;
}
