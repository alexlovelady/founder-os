"""Structure-aware legal chunking.

Boundaries follow headings, articles, sections and numbered clauses; small adjacent paragraphs in the same
section are packed together; oversized paragraphs are split at sentence boundaries with one sentence of overlap.
Invariant (tested): parsed.text[chunk.start:chunk.end] == chunk.text."""
import hashlib
import re
from dataclasses import dataclass, field

from .parsers import Block, ParsedDoc

TARGET_CHARS = 1000
MAX_CHARS = 2000

ARTICLE = re.compile(r"^(ARTICLE|Article)\s+([IVXLCDM]+|\d+)\b[.:\s-]*", re.I)
SECTION = re.compile(r"^(?:(Section|SECTION|Sec\.|§)\s*)?(\d+(?:\.\d+){0,4})[.)]?\s+(?=[A-Z\"“])")
CLAUSE = re.compile(r"^\(([a-z]{1,2}|[ivx]+|\d+)\)\s+")
SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“(])")


@dataclass
class Chunk:
    index: int
    text: str
    start: int
    end: int
    page: int | None
    page_end: int | None
    heading_path: list[str] = field(default_factory=list)
    section_number: str = ""

    @property
    def text_hash(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()

    def embedding_input(self) -> str:
        """Heading context improves retrieval; the stored/cited text stays the exact source slice."""
        return (" > ".join(self.heading_path) + "\n" if self.heading_path else "") + self.text


def _heading_of(b: Block) -> tuple[int, str] | None:
    """Returns (level, section_number) if this block is a heading, else None."""
    t = b.text
    if b.heading_level:
        m = SECTION.match(t) or ARTICLE.match(t)
        return b.heading_level, (m.group(0).strip(" .:-") if m else "")
    if len(t) > 120 or t.endswith((",", ";")):
        return None
    m = ARTICLE.match(t)
    if m:
        return 1, f"Article {m.group(2)}"
    m = SECTION.match(t)
    if m and len(t) <= 100 and not t.endswith("."):
        return 2 + m.group(2).count("."), m.group(2)
    if t.isupper() and 3 < len(t) < 80 and re.search(r"[A-Z]{3}", t):
        return 2, ""
    return None


def _split_long(text: str) -> list[tuple[int, int]]:
    """Sentence-boundary spans (relative offsets) of <= MAX_CHARS, with one-sentence overlap."""
    sents, pos = [], 0
    for m in SENT.finditer(text):
        sents.append((pos, m.start()))
        pos = m.end()
    sents.append((pos, len(text)))
    spans, i = [], 0
    while i < len(sents):
        s = sents[i][0]
        j = i
        while j + 1 < len(sents) and sents[j + 1][1] - s <= TARGET_CHARS:
            j += 1
        e = sents[j][1]
        while e - s > MAX_CHARS:  # a single giant sentence: hard split
            spans.append((s, s + MAX_CHARS))
            s += MAX_CHARS
        spans.append((s, e))
        i = j if j > i else j + 1  # overlap: next chunk starts at this chunk's last sentence
        if j == len(sents) - 1:
            break
    return spans


def chunk_document(doc: ParsedDoc) -> list[Chunk]:
    chunks: list[Chunk] = []
    path: list[tuple[int, str]] = []  # (level, heading text)
    section = ""
    pending: list[Block] = []

    def heading_path() -> list[str]:
        return [h for _, h in path]

    def emit(blocks: list[Block], start: int | None = None, end: int | None = None):
        if not blocks:
            return
        s = blocks[0].start if start is None else start
        e = blocks[-1].end if end is None else end
        chunks.append(Chunk(len(chunks), doc.text[s:e], s, e, blocks[0].page, blocks[-1].page,
                            heading_path(), section))

    def flush():
        nonlocal pending
        emit(pending)
        pending = []

    for b in doc.blocks:
        h = _heading_of(b)
        if h:
            flush()
            level, num = h
            while path and path[-1][0] >= level:
                path.pop()
            path.append((level, b.text[:160]))
            section = num
            continue
        m = CLAUSE.match(b.text)
        size = sum(x.end - x.start for x in pending)
        # a numbered provision ("2.2 Payment...") always starts a new chunk; sub-clauses "(a)" stay with their
        # parent until the chunk is reasonably full
        new_provision = bool(pending) and bool(SECTION.match(b.text))
        if pending and (new_provision or size + (b.end - b.start) > TARGET_CHARS
                        or (m and size > TARGET_CHARS // 2)):
            flush()
        if SECTION.match(b.text):
            mm = SECTION.match(b.text)
            section = mm.group(2)
        if b.end - b.start > MAX_CHARS:
            flush()
            for s, e in _split_long(b.text):
                emit([b], b.start + s, b.start + e)
            continue
        pending.append(b)
    flush()
    return chunks
