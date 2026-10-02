"""Heuristic document classification and jurisdiction/date detection (spec section 15).
These are suggestions stored with metadata_source='detected'; a user edit always wins and is never overwritten."""
import re
from datetime import date

STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida",
          "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
          "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska",
          "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
          "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
          "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
          "District of Columbia"]
_STATE_RE = "|".join(sorted((re.escape(s) for s in STATES), key=len, reverse=True))
GOVERNING = re.compile(
    rf"(?:governed\s+by|construed\s+(?:in\s+accordance\s+)?(?:with|under)|laws?\s+of)\s+(?:and\s+construed\s+(?:in\s+accordance\s+with\s+)?)?"
    rf"(?:the\s+)?(?:internal\s+)?(?:laws?\s+of\s+)?(?:the\s+)?(?:State\s+of\s+|Commonwealth\s+of\s+)?({_STATE_RE})\b", re.I)
FEDERAL = re.compile(r"\b(United States Code|U\.S\.C\.|Code of Federal Regulations|C\.F\.R\.|Federal Rules of|"
                     r"laws of the United States|federal law)(?!\w)", re.I)
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
MONTH_NUM = {m.lower(): i for i, m in enumerate(MONTHS.split("|"), 1)}
DATE_PATTERNS = [
    re.compile(rf"(?:effective\s+(?:as\s+of|date)[:\s,]*|dated\s+(?:as\s+of\s+)?|made\s+(?:and\s+entered\s+into\s+)?(?:as\s+of\s+|on\s+)?)"
               rf"({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})", re.I),
    re.compile(rf"\b({MONTHS})\s+(\d{{1,2}}),\s+(\d{{4}})", re.I),
]

CLASS_RULES = [
    ("contract", r"\b(agreement|this contract|hereinafter|whereas|indemnif|governing law|termination)\b", 3),
    ("statute", r"(§\s*\d|\bsection\s+\d+[\w.()-]*\s+(?:of|shall)|\bbe it enacted\b|\bu\.s\.c\.)", 2),
    ("regulation", r"\b(c\.f\.r\.|final rule|proposed rule|code of federal regulations)\b", 2),
    ("case", r"\b(plaintiff|defendant|appellant|appellee|petitioner|respondent|held that|the court)\b", 3),
    ("policy", r"\b(privacy policy|terms of service|terms of use|acceptable use|employee handbook)\b", 1),
    ("correspondence", r"^(from|to|subject|dear)\b", 2),
]


def detect_jurisdiction(text: str) -> str:
    m = GOVERNING.search(text[:200000])
    if m:
        name = m.group(1)
        return next(s for s in STATES if s.lower() == name.lower())
    if FEDERAL.search(text[:50000]):
        return "United States (Federal)"
    return ""


def detect_date(text: str) -> date | None:
    head = text[:6000]
    for pat in DATE_PATTERNS:
        m = pat.search(head)
        if m:
            try:
                return date(int(m.group(3)), MONTH_NUM[m.group(1).lower()], int(m.group(2)))
            except ValueError:
                continue
    return None


def classify(text: str) -> str:
    sample = text[:20000].lower()
    best, best_n = "other", 0
    for name, rx, min_hits in CLASS_RULES:
        n = len(re.findall(rx, sample, re.I | re.M))
        if n >= min_hits and n > best_n:
            best, best_n = name, n
    return best


AUTHORITY_FOR_CLASS = {"contract": "user_document", "statute": "statute", "regulation": "regulation", "case": "court_opinion",
                       "policy": "user_document", "correspondence": "user_document", "other": "user_document"}


# STATES is alphabetical (DC last), which is also the order of the postal codes below.
STATE_CODES = dict(zip(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(),
    STATES))


def normalize_jurisdiction(j: str) -> str:
    """Canonical lowercase key: 'US-DE', 'State of Delaware', 'delaware' -> 'delaware'; federal variants -> 'federal'."""
    t = re.sub(r"\s+", " ", (j or "").strip().lower())
    if not t:
        return ""
    if t in ("us-fed", "us", "federal", "united states", "united states (federal)", "u.s.", "us federal"):
        return "federal"
    m = re.fullmatch(r"us-([a-z]{2})", t)
    if m and m.group(1).upper() in STATE_CODES:
        return STATE_CODES[m.group(1).upper()].lower()
    t = re.sub(r"^(state|commonwealth) of ", "", t)
    return t
