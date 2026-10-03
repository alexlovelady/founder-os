"""Citation validation (spec section 18). The model may only cite IDs supplied by retrieval. After generation:
 1. every CITE-id must exist in the evidence set (which is already limited to the matter and current versions);
 2. unknown IDs are removed from the text and reported — a fabricated citation is never silently kept;
 3. each cited passage is checked for support of the sentence (lexical/numeric overlap, optionally upgraded or
    downgraded by an LLM entailment verdict);
 4. quotations must appear verbatim in a source passage (quotes.py);
 5. superseded or not-in-force sources are flagged;
 6. substantive claims with no citation are flagged."""
import re
from dataclasses import dataclass, field

from .quotes import extract_quotes, find_quote

CITE_ID = re.compile(r"CITE-\d{3,}")
BRACKET = re.compile(r"\[\s*((?:CITE-\d{3,}\s*[,;]?\s*)+)\]")
SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“(\[])")
WORDS = re.compile(r"[a-z]{4,}|\d[\d,.]*\d|\d")
STOP = {"that", "this", "with", "from", "have", "been", "were", "will", "shall", "would", "could", "should", "their",
        "there", "which", "when", "where", "under", "such", "than", "then", "them", "they", "also", "into", "other",
        "each", "does", "must", "upon", "about", "between", "party", "parties", "agreement", "section", "provides",
        "states", "requires", "according", "based", "however", "therefore", "because", "while", "whether"}
NON_CLAIM_SECTIONS = ("unresolved", "assumption", "missing", "facts", "practical", "next step", "question")
REMOVED = "[citation removed: not in retrieved sources]"


@dataclass
class EvidenceItem:
    cite_id: str
    chunk_id: str
    text: str
    document_id: str = ""
    title: str = ""
    version_number: int = 1
    page: int | None = None
    char_start: int = 0
    flags: list[str] = field(default_factory=list)


@dataclass
class Segment:
    text: str
    section: str = ""
    cites: list[str] = field(default_factory=list)
    status: str = "n/a"   # supported | partial | unsupported | uncited | invalid_citation | n/a
    issues: list[str] = field(default_factory=list)
    support: float | None = None
    line: int = 0  # line index in the answer text, for rendering


@dataclass
class ValidatedAnswer:
    cleaned: str
    segments: list[Segment]
    quotes: list[dict]
    fabricated: list[str]

    def summary(self) -> dict:
        st = [s.status for s in self.segments]
        q = [x["status"] for x in self.quotes]
        return {"segments": len(st), "supported": st.count("supported"), "partial": st.count("partial"),
                "unsupported": st.count("unsupported"), "uncited": st.count("uncited"),
                "invalid_citation": st.count("invalid_citation"), "fabricated_citations": self.fabricated,
                "quotes_verified": q.count("verified") + q.count("user_text"), "quotes_failed": q.count("mismatch"),
                "superseded_cited": sum("superseded_authority" in s.issues or "not_in_effect" in s.issues
                                        for s in self.segments)}

    @property
    def problem_count(self) -> int:
        s = self.summary()
        return len(s["fabricated_citations"]) + s["quotes_failed"] + s["unsupported"]


def _stems(text: str) -> set[str]:
    out = set()
    for w in WORDS.findall(text.lower()):
        if w in STOP:
            continue
        out.add(w.replace(",", "") if w[0].isdigit() else w[:6])
    return out


def support_score(claim: str, passages: list[str]) -> tuple[float, bool]:
    """(share of the claim's content words found in the passages, all numbers present)."""
    c = _stems(BRACKET.sub("", claim))
    if not c:
        return 1.0, True
    p = set().union(*(_stems(x) for x in passages)) if passages else set()
    nums = {w for w in c if w[0].isdigit()}
    return len(c & p) / len(c), nums <= p


def _level(score: float, nums_ok: bool) -> str:
    lvl = "supported" if score >= 0.5 else "partial" if score >= 0.3 else "unsupported"
    if not nums_ok:
        lvl = {"supported": "partial", "partial": "unsupported"}.get(lvl, lvl)
    return lvl


def _is_substantive(sentence: str) -> bool:
    s = BRACKET.sub("", sentence).strip()
    return (len(s.split()) >= 8 and not s.endswith("?") and not s.startswith(("#", "|", "---"))
            and not re.match(r"(?i)^none", s))


def split_line(line: str) -> list[str]:
    """Sentence split that never cuts inside a quotation, so a quoted passage spanning several sentences stays whole."""
    out, start = [], 0
    for m in SENT.finditer(line):
        before = line[start:m.start()]
        straight = before.count('"') % 2 == 1
        curly = before.count("“") > before.count("”")
        if straight or curly:
            continue
        out.append(line[start:m.start()])
        start = m.end()
    out.append(line[start:])
    return [s for s in out if s.strip()]


def split_segments(answer: str) -> list[tuple[str, str, int]]:
    """[(sentence, section, line_no)] preserving order; headings yield ('## Title', title, line_no)."""
    out, section = [], ""
    for ln, line in enumerate(answer.splitlines()):
        if not line.strip():
            continue
        if line.lstrip().startswith("#"):
            section = line.lstrip("# ").strip().lower()
            out.append((line, section, ln))
            continue
        for sent in split_line(line):
            out.append((sent, section, ln))
    return out


def validate_answer(answer: str, evidence: list[EvidenceItem], *, user_text: str = "",
                    llm_verdicts: dict[int, str] | None = None) -> ValidatedAnswer:
    by_id = {e.cite_id: e for e in evidence}
    texts = [e.text for e in evidence]
    index_of = {e.cite_id: i for i, e in enumerate(evidence)}
    segs: list[Segment] = []
    quotes: list[dict] = []
    fabricated: list[str] = []

    prev_cited_line = -1  # line number of the most recent sentence that carried a valid citation
    for n, (sent, section, ln) in enumerate(split_segments(answer)):
        if sent.lstrip().startswith("#"):
            segs.append(Segment(sent, section))
            continue
        ids = list(dict.fromkeys(CITE_ID.findall(sent)))
        bad = [i for i in ids if i not in by_id]
        good = [i for i in ids if i in by_id]
        fabricated += [i for i in bad if i not in fabricated]

        def repl(m):
            kept = [i for i in CITE_ID.findall(m.group(1)) if i in by_id]
            return f"[{', '.join(kept)}]" if kept else REMOVED
        clean = BRACKET.sub(repl, sent)
        clean = CITE_ID.sub(lambda m: m.group(0) if m.group(0) in by_id else "", clean)  # bare fabricated ids

        seg = Segment(clean, section, good)
        claim = BRACKET.sub("", clean).replace(REMOVED, "")
        if bad:
            seg.status = "invalid_citation"
            seg.issues += [f"fabricated_citation:{i}" for i in bad]
        if good:
            score, nums_ok = support_score(claim, [by_id[i].text for i in good])
            seg.support = round(score, 2)
            lvl = _level(score, nums_ok)
            v = (llm_verdicts or {}).get(n)
            if v == "no" and lvl != "supported":
                lvl = "unsupported"
            elif v == "yes" and nums_ok:
                lvl = "supported"
            elif v == "partial" and lvl == "supported":
                lvl = "partial"
            if not bad:
                seg.status = lvl
            if lvl == "unsupported":
                seg.issues.append("cited_source_does_not_support_claim")
            if not nums_ok:
                seg.issues.append("number_not_in_source")
            for i in good:
                if "superseded" in by_id[i].flags:
                    seg.issues.append("superseded_authority")
                if "not_in_effect_on_date" in by_id[i].flags:
                    seg.issues.append("not_in_effect")
        elif not bad and _is_substantive(clean) and not any(k in section for k in NON_CLAIM_SECTIONS):
            if prev_cited_line == ln:  # follows a cited sentence in the same paragraph: context, not a new claim source
                seg.status = "continuation"
            else:
                seg.status = "uncited"
                seg.issues.append("claim_without_citation")
        if good:
            prev_cited_line = ln
        elif seg.status not in ("continuation",) and ln != prev_cited_line:
            prev_cited_line = -1

        for q in extract_quotes(clean):
            m = find_quote(q, texts, prefer=[index_of[i] for i in good])
            if m:
                e = evidence[m.chunk_index]
                rec = {"quote": q, "status": "verified", "cite_id": e.cite_id, "chunk_id": e.chunk_id,
                       "document_id": e.document_id, "page": e.page, "chunk_start": m.start, "chunk_end": m.end,
                       "doc_start": e.char_start + m.start, "doc_end": e.char_start + m.end}
                if good and e.cite_id not in good:
                    seg.issues.append("quote_from_different_source")
            elif user_text and find_quote(q, [user_text]):
                rec = {"quote": q, "status": "user_text"}
            else:
                rec = {"quote": q, "status": "mismatch"}
                seg.issues.append("quote_not_found_verbatim")
            quotes.append(rec)
            if rec["status"] == "verified" and seg.status in ("uncited", "continuation") and not seg.cites:
                seg.status, seg.cites = "supported", [rec["cite_id"]]  # a verbatim quote is its own evidence
                seg.issues = [i for i in seg.issues if i != "claim_without_citation"]
                prev_cited_line = ln
        segs.append(seg)

    return ValidatedAnswer(_rebuild(answer, segs), segs, quotes, fabricated)


def _rebuild(original: str, segs: list[Segment]) -> str:
    """Re-assemble cleaned text keeping the original line structure (headings, bullets, blank lines)."""
    it = iter(segs)
    out_lines = []
    for ln, line in enumerate(original.splitlines()):
        if not line.strip():
            out_lines.append(line)
        elif line.lstrip().startswith("#"):
            next(it).line = ln
            out_lines.append(line)
        else:
            parts = split_line(line)
            group = [next(it) for _ in parts]
            for sg in group:
                sg.line = ln
            out_lines.append(" ".join(sg.text for sg in group))
    return "\n".join(out_lines)
