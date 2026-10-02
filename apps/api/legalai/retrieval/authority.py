"""Authority-aware scoring (spec section 13). Everything is expressed in units of one top-ranked RRF slot
(u = 1 / (rrf_k + 1)) so the bonuses stay commensurate with the fused retrieval score. Weights are configuration
to be benchmarked, not truth."""
from dataclasses import dataclass, field
from datetime import date

from ..ingestion.detect import normalize_jurisdiction
from ..models import Document

TYPE_WEIGHT = {"constitution": 4.0, "statute": 3.5, "regulation": 3.0, "court_rule": 3.0, "court_opinion": 2.5,
               "administrative_guidance": 2.0, "agency_material": 2.0, "user_document": 2.0, "official_form": 1.5,
               "treatise": 1.0, "template": 0.5}
COURT_WEIGHT = {"supreme": 1.5, "appellate": 1.0, "trial": 0.5, "agency": 0.5, "": 0.0}
NEGATIVE_TREATMENT = {"overruled", "reversed", "vacated", "abrogated", "superseded_by", "repealed"}
QUESTIONED_TREATMENT = {"questioned", "criticized", "limited", "distinguished_adversely"}
PRIMARY = {"constitution", "statute", "regulation", "court_rule", "court_opinion"}


@dataclass
class AuthorityAssessment:
    bonus_units: float = 0.0
    flags: list[str] = field(default_factory=list)
    label: str = "secondary"  # primary | secondary | user_document


def assess(doc: Document, matter_jurisdiction: str, as_of: date | None, jurisdictions: list[str] | None = None
           ) -> AuthorityAssessment:
    a = AuthorityAssessment()
    a.label = "user_document" if doc.authority_type == "user_document" else \
        "primary" if doc.authority_type in PRIMARY else "secondary"
    b = TYPE_WEIGHT.get(doc.authority_type, 1.0) * 0.25 + COURT_WEIGHT.get(doc.court_level, 0.0) * 0.25
    want = {normalize_jurisdiction(j) for j in (jurisdictions or [matter_jurisdiction]) if j}
    have = normalize_jurisdiction(doc.jurisdiction)
    if want:
        if not have:
            a.flags.append("jurisdiction_unknown")
        elif have in want:
            b += 1.0
        else:
            b -= 1.5
            a.flags.append("jurisdiction_mismatch")
    if doc.superseded:
        b -= 3.0
        a.flags.append("superseded")
    if as_of and ((doc.effective_from and doc.effective_from > as_of) or (doc.effective_to and doc.effective_to < as_of)):
        b -= 3.0
        a.flags.append("not_in_effect_on_date")
    kinds = {t.get("type") for t in (doc.treatment or []) if isinstance(t, dict)}
    if kinds & NEGATIVE_TREATMENT:
        b -= 2.5
        a.flags.append("negative_treatment")
    elif kinds & QUESTIONED_TREATMENT:
        b -= 1.0
        a.flags.append("questioned_treatment")
    if doc.official_source:
        b += 0.25
    a.bonus_units = b
    return a
