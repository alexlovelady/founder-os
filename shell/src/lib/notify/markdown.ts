/** A tiny, safe renderer for the brief's own markdown subset (headings, bullets, numbered lists, paragraphs). Never emits raw input as HTML. */
export type Block =
  | { type: "h1"; text: string }
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

export function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^##\s+(.*)$/))) out.push({ type: "h2", text: m[1] });
    else if ((m = line.match(/^#\s+(.*)$/))) out.push({ type: "h1", text: m[1] });
    else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      const last = out[out.length - 1];
      if (last?.type === "ul") last.items.push(m[1]);
      else out.push({ type: "ul", items: [m[1]] });
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      const last = out[out.length - 1];
      if (last?.type === "ol") last.items.push(m[1]);
      else out.push({ type: "ol", items: [m[1]] });
    } else out.push({ type: "p", text: line });
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function markdownToHtml(md: string): string {
  return parseBlocks(md)
    .map((b) => {
      if (b.type === "h1") return `<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(b.text)}</h1>`;
      if (b.type === "h2") return `<h2 style="font-size:16px;margin:20px 0 6px">${escapeHtml(b.text)}</h2>`;
      if (b.type === "p") return `<p style="margin:6px 0">${escapeHtml(b.text)}</p>`;
      const tag = b.type;
      return `<${tag} style="margin:6px 0;padding-left:20px">${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</${tag}>`;
    })
    .join("\n");
}
