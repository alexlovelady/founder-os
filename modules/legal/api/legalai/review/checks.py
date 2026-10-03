"""Deterministic contract checks (no LLM): defined terms, cross-references, clause topics, missing terms, key figures.
These run on the stored text, so their results are reproducible and cannot be hallucinated."""
import re
from dataclasses import dataclass

# ---- defined terms --------------------------------------------------------------------------------------------
DEF_PATTERNS = [
    re.compile(r'[“"]([A-Z][\w\-&\' ]{1,60}?)[”"]\s+(?:means|shall mean|has the meaning|refers to|is defined|shall have the meaning)'),
    re.compile(r'\((?:the |each,? |collectively,? |together,? the |hereinafter )*[“"]([A-Z][\w\-&\' ]{1,60}?)[”"]\)'),
    re.compile(r'(?:hereinafter|herein|hereafter)\s+(?:referred to as\s+)?(?:the\s+)?[“"]([A-Z][\w\-&\' ]{1,60}?)[”"]'),
]
CAP_TERM = re.compile(r"\b([A-Z][a-z]+(?:\s+(?:of\s+|and\s+)?[A-Z][a-z]+){0,3})\b")
COMMON = {"The", "This", "That", "These", "Those", "Each", "Either", "Any", "All", "Such", "Neither", "Both", "In",
          "If", "Unless", "Subject", "Section", "Article", "Exhibit", "Schedule", "Party", "Parties", "Agreement",
          "Effective Date", "Whereas", "Now", "Notwithstanding", "Except", "For", "Upon", "During", "Without",
          "Delaware", "State", "United States", "Customer", "Company", "Service", "Services", "Term", "Notice",
          "Payment", "Fees", "Confidential", "Governing Law", "Entire Agreement", "Miscellaneous", "Termination",
          "Indemnification", "Definitions", "Counterparts", "Assignment", "Severability", "Waiver", "Amendment"}
DETERMINERS = {"This", "The", "That", "These", "Those", "Each", "Either", "Any", "All", "Such", "Neither", "Both", "In", "If", "For", "Upon"}
MONTHS = {"January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"}


def defined_terms(text: str) -> set[str]:
    out = set()
    for rx in DEF_PATTERNS:
        for m in rx.finditer(text):
            out.add(m.group(1).strip())
    return out


def undefined_terms(text: str, min_uses: int = 2) -> list[dict]:
    """Capitalized multi-word terms used repeatedly in mid-sentence but never defined."""
    defined = {d.lower() for d in defined_terms(text)}
    counts: dict[str, int] = {}
    for m in CAP_TERM.finditer(text):
        t = m.group(1)
        start = m.start()
        sentence_start = start == 0 or re.search(r"(?:[.!?:;]|\n)\s*$", text[max(0, start - 3):start]) is not None
        if sentence_start and " " not in t:
            continue
        if t in COMMON or t.split()[0] in MONTHS or t in MONTHS or len(t) < 4 or t.split()[0] in DETERMINERS:
            continue
        counts[t] = counts.get(t, 0) + 1
    out = []
    for t, n in sorted(counts.items(), key=lambda x: -x[1]):
        if n >= min_uses and t.lower() not in defined and not any(t.lower() in d or d in t.lower() for d in defined):
            if " " in t or n >= 3:
                out.append({"term": t, "uses": n})
    return out


def unused_definitions(text: str) -> list[str]:
    out = []
    for d in sorted(defined_terms(text)):
        uses = len(re.findall(rf"\b{re.escape(d)}\b", text))
        if uses <= 1:
            out.append(d)
    return out


# ---- cross references -----------------------------------------------------------------------------------------
XREF = re.compile(r"\b(Sections?|Articles?|Exhibits?|Schedules?|Appendix|Annex)\s+((?:[IVXLC]+|\d+(?:\.\d+)*|[A-Z])(?:\([a-z0-9]+\))*)")
SECTION_DEF = re.compile(r"(?m)^\s*(?:Section\s+|SECTION\s+|§\s*)?(\d+(?:\.\d+)*)[.)]?\s+\S")
ARTICLE_DEF = re.compile(r"(?mi)^\s*ARTICLE\s+([IVXLC]+|\d+)\b")
EXHIBIT_DEF = re.compile(r"(?mi)^\s*(Exhibit|Schedule|Appendix|Annex)\s+([A-Z0-9]+)\b")


def section_numbers(text: str) -> set[str]:
    nums = set(SECTION_DEF.findall(text))
    out = set(nums)
    for n in nums:  # 2.1 implies 2 exists as a parent
        parts = n.split(".")
        out.update(".".join(parts[:i]) for i in range(1, len(parts)))
    return out


def broken_cross_references(text: str) -> list[dict]:
    secs, arts = section_numbers(text), {a.upper() for a in ARTICLE_DEF.findall(text)}
    exhibits = {(k.lower(), v.upper()) for k, v in EXHIBIT_DEF.findall(text)}
    broken, seen = [], set()
    for m in XREF.finditer(text):
        kind, ref = m.group(1).lower().rstrip("s"), m.group(2)
        base = re.sub(r"\(.*", "", ref)
        key = (kind, ref)
        if key in seen:
            continue
        seen.add(key)
        ctx = text[max(0, m.start() - 40):m.end() + 40].replace("\n", " ")
        around = text[max(0, m.start() - 40):m.start()] + "|" + text[m.end():m.end() + 40]
        if re.search(r"(?i)of the (?:code|act)|U\.S\.C|C\.F\.R|\bUCC\b|Internal Revenue", around):
            continue  # reference to external law, not this document
        if kind == "section" and base not in secs:
            broken.append({"reference": m.group(0), "context": ctx})
        elif kind == "article" and base.upper() not in arts and base not in secs:
            broken.append({"reference": m.group(0), "context": ctx})
        elif kind in ("exhibit", "schedule", "appendix", "annex") and (kind, base.upper()) not in exhibits:
            broken.append({"reference": m.group(0), "context": ctx, "note": "attachment not found in this document"})
    return broken


# ---- topics ---------------------------------------------------------------------------------------------------
TOPICS = {
    "term_and_renewal": r"\b(term of this agreement|initial term|renew|renewal|expire|expiration)\b",
    "termination": r"\b(terminat\w+|cure period|breach)\b",
    "payment": r"\b(pay\w*|invoice\w*|fees?|compensation|price|late charge|interest)\b",
    "indemnification": r"\b(indemnif\w+|hold harmless|defend)\b",
    "limitation_of_liability": r"\b(limitation of liability|consequential damages|aggregate liability|liability (?:shall|will) not exceed|cap)\b",
    "intellectual_property": r"\b(intellectual property|work product|copyright|patent|licen[sc]e|ownership of)\b",
    "confidentiality": r"\b(confidential\w*|non-disclosure|trade secret)\b",
    "governing_law_forum": r"\b(governed by|governing law|jurisdiction|venue|arbitration|forum)\b",
    "assignment": r"\b(assign\w*|change of control|delegate)\b",
    "warranties": r"\b(warrant\w+|represent\w*|as is|disclaim\w*)\b",
    "insurance": r"\b(insurance|insured)\b",
    "data_protection": r"\b(personal data|personal information|data protection|privacy|security incident|breach of security)\b",
    "force_majeure": r"\bforce majeure\b",
    "dispute_resolution": r"\b(dispute\w*|arbitrat\w+|mediation|injunctive)\b",
    "notices": r"\b(notices?|in writing to)\b",
    "entire_agreement": r"\b(entire agreement|supersede\w*|integration)\b",
    "non_compete_solicit": r"\b(non-?compet\w+|non-?solicit\w*)\b",
    "exclusivity": r"\bexclusiv\w+\b",
    # startup and small-business agreements
    "vesting": r"\b(vest\w*|cliff|repurchase right|unvested)\b",
    "equity_ownership": r"\b(shares?|membership interests?|units?|equity|percentage interest|capitalization)\b",
    "roles_and_duties": r"\b(duties|responsibilit\w+|devote|full[- ]time|officer|title|reports? to)\b",
    "management_and_voting": r"\b(manager|managing member|board of (?:directors|managers)|vote|voting|majority|unanimous|quorum)\b",
    "capital_contributions": r"\b(capital contribution\w*|additional capital|capital call|initial contribution)\b",
    "distributions": r"\b(distribut\w+|allocation|profits? and losses|tax distribution)\b",
    "transfer_restrictions": r"\b(right of first refusal|rofr|transfer restrictions?|co-sale|tag[- ]along|drag[- ]along|lock-?up|permitted transferee)\b",
    "departure_and_buyout": r"\b(buy-?sell|buyout|call right|good leaver|bad leaver|departure|withdraw\w*|resign\w*|fair market value)\b",
    "dissolution": r"\b(dissol\w+|winding up|liquidat\w+)\b",
    "deadlock": r"\b(deadlock|impasse|mediation|buy-?sell)\b",
    "conversion": r"\b(convert\w*|conversion|equity financing|qualified financing|liquidity event|change of control)\b",
    "valuation_cap_discount": r"\b(valuation cap|post-money|pre-money|discount rate|discount)\b",
    "investor_rights": r"\b(pro rata|most favored nation|mfn|information rights?|anti-dilution|preemptive)\b",
    "fiduciary_and_indemnity": r"\b(fiduciary|duty of loyalty|exculpat\w+|indemnif\w+ (?:the )?(?:manager|member|officer|director))\b",
    "tax_matters": r"\b(partnership representative|tax matters|83\(b\)|section 83|k-1|tax status)\b",
    "background_ip_assignment": r"\b(assigns?|assignment of (?:all )?(?:inventions|intellectual property|work product)|work made for hire|prior inventions)\b",
}
EXPECTED = {
    "founders_agreement": ["equity_ownership", "vesting", "roles_and_duties", "management_and_voting", "background_ip_assignment",
                           "confidentiality", "departure_and_buyout", "deadlock", "governing_law_forum"],
    "operating_agreement": ["equity_ownership", "capital_contributions", "distributions", "management_and_voting", "transfer_restrictions",
                            "departure_and_buyout", "dissolution", "fiduciary_and_indemnity", "tax_matters", "governing_law_forum"],
    "safe": ["valuation_cap_discount", "conversion", "investor_rights", "dissolution", "governing_law_forum"],
    "convertible_note": ["conversion", "valuation_cap_discount", "term_and_renewal", "payment", "governing_law_forum"],
    "stock_purchase": ["equity_ownership", "vesting", "transfer_restrictions", "tax_matters", "warranties", "governing_law_forum"],
    "offer_letter": ["payment", "roles_and_duties", "termination", "equity_ownership", "confidentiality", "background_ip_assignment"],
    "contractor": ["roles_and_duties", "payment", "term_and_renewal", "termination", "background_ip_assignment", "confidentiality",
                   "governing_law_forum"],
    "ip_assignment": ["background_ip_assignment", "warranties", "confidentiality", "governing_law_forum"],
    "privacy_policy": ["data_protection", "notices"],
    "terms_of_service": ["limitation_of_liability", "intellectual_property", "warranties", "governing_law_forum", "termination", "dispute_resolution"],
    "contract": ["term_and_renewal", "termination", "payment", "limitation_of_liability", "confidentiality",
                 "governing_law_forum", "assignment", "notices", "entire_agreement"],
    "nda": ["confidentiality", "term_and_renewal", "governing_law_forum", "notices", "entire_agreement"],
    "employment": ["termination", "payment", "confidentiality", "intellectual_property", "governing_law_forum"],
    "saas": ["term_and_renewal", "termination", "payment", "limitation_of_liability", "data_protection",
             "intellectual_property", "confidentiality", "governing_law_forum", "warranties"],
}


def classify_topics(text: str) -> list[str]:
    return [t for t, rx in TOPICS.items() if re.search(rx, text, re.I)]


def missing_topics(full_text: str, agreement_type: str = "contract", extra: list[str] | None = None) -> list[str]:
    present = set(classify_topics(full_text))
    want = EXPECTED.get(agreement_type, EXPECTED["contract"]) + [t for t in (extra or []) if t in TOPICS]
    return [t for t in dict.fromkeys(want) if t not in present]


AGREEMENT_PATTERNS = [
    ("safe", r"simple agreement for future equity|\bsafe\b.*(?:post-money|pre-money|valuation cap)"),
    ("convertible_note", r"convertible (?:promissory )?note"),
    ("founders_agreement", r"founders?['\u2019]? (?:agreement|collaboration|stock)|co-?founder"),
    ("operating_agreement", r"operating agreement|limited liability company agreement|llc agreement"),
    ("stock_purchase", r"(?:restricted )?stock purchase agreement"),
    ("offer_letter", r"offer letter|offer of employment"),
    ("ip_assignment", r"(?:intellectual property|invention|ip) assignment|assignment of inventions"),
    ("contractor", r"independent contractor|consulting agreement|contractor agreement"),
    ("privacy_policy", r"privacy (?:policy|notice)"),
    ("terms_of_service", r"terms of (?:service|use)|user agreement"),
]


def detect_agreement_type(text: str) -> str:
    h = text[:3000].lower()
    for name, pat in AGREEMENT_PATTERNS:
        if re.search(pat, h):
            return name
    if re.search(r"non-?disclosure|confidentiality agreement|mutual nda", h):
        return "nda"
    if re.search(r"employment agreement|offer of employment|employee", h):
        return "employment"
    if re.search(r"software as a service|saas|subscription (?:agreement|terms)|master subscription", h):
        return "saas"
    return "contract"


# ---- key figures ----------------------------------------------------------------------------------------------
MONEY = re.compile(r"(?:US\s?)?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|thousand))?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|USD)\b", re.I)
DURATION = re.compile(r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|forty-five|sixty|ninety)\s*(?:\(\d+\)\s*)?(?:business |calendar )?(?:days?|weeks?|months?|years?)\b", re.I)
PERCENT = re.compile(r"\b\d+(?:\.\d+)?\s?(?:%|percent\b)", re.I)


@dataclass
class Figures:
    money: list[str]
    durations: list[str]
    percents: list[str]


def key_figures(text: str) -> Figures:
    n = lambda xs: sorted({re.sub(r"\s+", " ", x.strip().lower()) for x in xs})
    return Figures(n(MONEY.findall(text)), n(DURATION.findall(text)), n(PERCENT.findall(text)))
