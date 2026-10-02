"""Document parsers. Output is a ParsedDoc: normalized full text plus Blocks that carry exact character
offsets into that text, page numbers, and heading information. Chunk anchors are derived from these offsets."""
import email
import io
import re
import zipfile
from dataclasses import dataclass, field
from email import policy
from html.parser import HTMLParser

from defusedxml import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class ParseError(Exception):
    pass


class NeedsOcr(ParseError):
    """No extractable text layer (scanned/image document)."""


@dataclass
class Block:
    text: str
    page: int | None = None
    heading_level: int = 0  # 0 = body paragraph, 1..6 = heading
    start: int = 0
    end: int = 0


@dataclass
class ParsedDoc:
    blocks: list[Block] = field(default_factory=list)
    page_count: int | None = None
    text: str = ""

    def finalize(self) -> "ParsedDoc":
        parts, pos = [], 0
        kept = []
        for b in self.blocks:
            t = re.sub(r"[ \t ]+", " ", b.text).strip()
            if not t:
                continue
            b.text, b.start = t, pos
            b.end = pos + len(t)
            parts.append(t)
            pos = b.end + 2  # "\n\n" separator
            kept.append(b)
        self.blocks = kept
        self.text = "\n\n".join(parts)
        return self


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("utf-8", errors="replace")


def _split_paragraphs(text: str, page: int | None = None) -> list[Block]:
    out = []
    for para in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        lines = [ln.strip() for ln in para.split("\n") if ln.strip()]
        if lines:
            out.append(Block(" ".join(lines), page))
    return out


def parse_text(data: bytes) -> ParsedDoc:
    return ParsedDoc(_split_paragraphs(_decode(data))).finalize()


def parse_markdown(data: bytes) -> ParsedDoc:
    blocks: list[Block] = []
    buf: list[str] = []

    def flush():
        if buf:
            blocks.extend(_split_paragraphs("\n".join(buf)))
            buf.clear()

    for line in _decode(data).replace("\r\n", "\n").split("\n"):
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
        if m:
            flush()
            blocks.append(Block(m.group(2), None, len(m.group(1))))
        elif not line.strip():
            buf.append("")
            buf.append("")
        else:
            buf.append(line)
    flush()
    return ParsedDoc(blocks).finalize()


def parse_pdf(data: bytes) -> ParsedDoc:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ParseError("PDF is encrypted")
        blocks: list[Block] = []
        for i, page in enumerate(reader.pages, start=1):
            blocks.extend(_split_paragraphs(page.extract_text() or "", i))
        n = len(reader.pages)
    except PyPdfError as e:
        raise ParseError(f"Unreadable PDF: {e}") from e
    doc = ParsedDoc(blocks, n).finalize()
    if len(doc.text.strip()) < 30:
        raise NeedsOcr("PDF has no extractable text layer; OCR required")
    return doc


def parse_docx(data: bytes) -> ParsedDoc:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = ET.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as e:
        raise ParseError(f"Unreadable DOCX: {e}") from e
    blocks: list[Block] = []
    for p in root.iter(W + "p"):
        text = _para_text(p)
        style = p.find(f"{W}pPr/{W}pStyle")
        level = 0
        if style is not None:
            m = re.match(r"(?i)^heading\s*(\d)$|^title$", style.get(W + "val", ""))
            if m:
                level = int(m.group(1)) if m.group(1) else 1
        blocks.append(Block(text, None, level))
    return ParsedDoc(blocks).finalize()


def _para_text(p) -> str:
    out = []
    for el in p.iter():
        if el.tag == W + "t":
            out.append(el.text or "")
        elif el.tag in (W + "tab",):
            out.append(" ")
        elif el.tag in (W + "br", W + "cr"):
            out.append(" ")
    return "".join(out)


class _Html(HTMLParser):
    BLOCK = {"p", "div", "li", "tr", "br", "section", "article", "blockquote", "pre", "table", "ul", "ol"}
    SKIP = {"script", "style", "head", "noscript", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self.buf: list[str] = []
        self.skip = 0
        self.heading = 0

    def flush(self):
        t = "".join(self.buf).strip()
        if t:
            self.blocks.append(Block(t, None, self.heading))
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif re.fullmatch(r"h[1-6]", tag):
            self.flush()
            self.heading = int(tag[1])
        elif tag in self.BLOCK:
            self.flush()

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif re.fullmatch(r"h[1-6]", tag):
            self.flush()
            self.heading = 0
        elif tag in self.BLOCK:
            self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)


def parse_html(data: bytes) -> ParsedDoc:
    p = _Html()
    p.feed(_decode(data))
    p.flush()
    return ParsedDoc(p.blocks).finalize()


def parse_eml(data: bytes) -> ParsedDoc:
    msg = email.message_from_bytes(data, policy=policy.default)
    head = "\n".join(f"{h}: {msg[h]}" for h in ("From", "To", "Cc", "Date", "Subject") if msg[h])
    body = msg.get_body(preferencelist=("plain", "html"))
    text = ""
    if body is not None:
        raw = body.get_content()
        text = parse_html(raw.encode()).text if body.get_content_type() == "text/html" else raw
    blocks = [Block(head)] if head else []
    blocks += _split_paragraphs(text)
    return ParsedDoc(blocks).finalize()


def parse_document(filename: str, data: bytes) -> ParsedDoc:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "pdf":
        doc = parse_pdf(data)
    elif ext == "docx":
        doc = parse_docx(data)
    elif ext == "md":
        doc = parse_markdown(data)
    elif ext in ("html", "htm"):
        doc = parse_html(data)
    elif ext == "eml":
        doc = parse_eml(data)
    elif ext == "txt":
        doc = parse_text(data)
    elif ext in ("png", "jpg", "jpeg", "tif", "tiff"):
        raise NeedsOcr("Image documents require OCR")
    else:
        raise ParseError(f"No parser for .{ext}")
    if not doc.text.strip():
        raise NeedsOcr("No text could be extracted")
    return doc
