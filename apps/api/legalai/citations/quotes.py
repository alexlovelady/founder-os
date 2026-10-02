"""Quote verification (spec section 19). A quotation passes only if it appears character-for-character in a stored
source passage. Allowed normalization: runs of whitespace, and typographic variants of quotes/dashes/spaces
(mapped 1:1 so offsets stay exact). Case, wording and punctuation otherwise must match."""
import re
from dataclasses import dataclass

_MAP = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
                      "‑": "-", "‐": "-", " ": " ", " ": " ", " ": " "})
QUOTE_RE = re.compile(r'"([^"\n]{12,}?)"|“([^”\n]{12,}?)”')
ELLIPSIS = re.compile(r"\s*(?:\.\.\.|…)\s*")
MIN_FRAGMENT = 8


def norm(t: str) -> str:
    return t.translate(_MAP)


@dataclass
class QuoteMatch:
    chunk_index: int      # index into the candidate list passed in
    start: int            # offsets within the chunk text
    end: int


def _find_fragment(fragment: str, haystack: str, from_pos: int = 0) -> tuple[int, int] | None:
    toks = norm(fragment).strip().split()
    if not toks:
        return None
    rx = re.compile(r"\s+".join(re.escape(t) for t in toks))
    m = rx.search(haystack, from_pos)
    return (m.start(), m.end()) if m else None


def find_quote(quote: str, texts: list[str], prefer: list[int] | None = None) -> QuoteMatch | None:
    """Search candidate chunk texts (preferred indexes first). Ellipsized quotes must have every fragment, in order,
    inside one chunk."""
    fragments = [f for f in ELLIPSIS.split(quote.strip()) if f.strip()]
    if not fragments or any(len(f.strip()) < MIN_FRAGMENT for f in fragments):
        return None
    order = list(dict.fromkeys((prefer or []) + list(range(len(texts)))))
    for i in order:
        hay = norm(texts[i])
        pos, first = 0, None
        for f in fragments:
            hit = _find_fragment(f, hay, pos)
            if not hit:
                first = None
                break
            first = first or hit
            pos = hit[1]
        else:
            return QuoteMatch(i, first[0], pos)
    return None


def extract_quotes(text: str) -> list[str]:
    return [(m.group(1) or m.group(2)).strip() for m in QUOTE_RE.finditer(text)]
