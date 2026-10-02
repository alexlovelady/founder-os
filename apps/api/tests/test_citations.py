from datetime import date

from legalai.citations.quotes import find_quote, extract_quotes
from legalai.citations.validate import EvidenceItem, validate_answer
from legalai.ingestion.detect import classify, detect_date, detect_jurisdiction, normalize_jurisdiction
from legalai.ingestion.parsers import parse_document
from legalai.ingestion.chunking import chunk_document

TERM = ("Either party may terminate for convenience on thirty days written notice. "
        "The Customer shall pay all undisputed invoices within thirty days of receipt.")
EV = [EvidenceItem("CITE-001", "c1", TERM, "d1", "msa.txt", 1, 2, char_start=100),
      EvidenceItem("CITE-002", "c2", "Each party shall indemnify the other against third party claims arising from "
                   "its gross negligence.", "d1", "msa.txt", 1, 3, char_start=400, flags=["superseded"])]


def v(answer, **kw):
    return validate_answer(answer, EV, **kw)


def seg(res, needle):
    return next(s for s in res.segments if needle in s.text)


def test_fabricated_citation_is_removed_and_reported_not_kept():
    r = v("## Analysis\nEither party may terminate on thirty days notice [CITE-001]. Punitive damages are capped [CITE-099].")
    assert r.fabricated == ["CITE-099"]
    assert "CITE-099" not in r.cleaned and "citation removed" in r.cleaned and "[CITE-001]" in r.cleaned
    s = seg(r, "Punitive")
    assert s.status == "invalid_citation" and "fabricated_citation:CITE-099" in s.issues


def test_bare_and_multi_id_markers_handled():
    r = v("## Analysis\nParties may terminate on thirty days written notice [CITE-001, CITE-777]. Also see CITE-555 here.")
    assert "CITE-777" not in r.cleaned and "CITE-555" not in r.cleaned and "[CITE-001]" in r.cleaned
    assert set(r.fabricated) == {"CITE-777", "CITE-555"}


def test_support_levels_and_numbers():
    ok = v("## Analysis\nEither party may terminate for convenience on thirty days written notice [CITE-001].")
    assert seg(ok, "terminate").status == "supported"
    bad = v("## Analysis\nThe landlord must provide quiet enjoyment of the premises throughout the lease [CITE-001].")
    assert seg(bad, "landlord").status == "unsupported" and "cited_source_does_not_support_claim" in seg(bad, "landlord").issues
    num = v("## Analysis\nEither party may terminate for convenience on ninety 90 days written notice [CITE-001].")
    assert "number_not_in_source" in seg(num, "terminate").issues and seg(num, "terminate").status != "supported"


def test_llm_verdict_can_downgrade_and_upgrade():
    txt = "## Analysis\nEither party may terminate for convenience on thirty days written notice [CITE-001]."
    assert seg(v(txt, llm_verdicts={1: "no"}), "terminate").status == "supported"   # strong lexical support is kept
    weak = "## Analysis\nThe contract allows exit whenever someone wants out of the deal [CITE-001]."
    assert seg(v(weak), "exit").status in ("unsupported", "partial")
    assert seg(v(weak, llm_verdicts={1: "yes"}), "exit").status == "supported"
    assert seg(v(weak, llm_verdicts={1: "no"}), "exit").status == "unsupported"


def test_uncited_claims_flagged_but_not_in_unresolved_section():
    r = v("## Analysis\nThe agreement contains a broad indemnification obligation covering all losses.\n"
          "## Unresolved Facts and Assumptions\nWe do not know whether the counterparty has been notified of anything yet.")
    assert seg(r, "indemnification").status == "uncited"
    assert seg(r, "counterparty").status == "n/a"


def test_superseded_source_flagged():
    r = v("## Analysis\nEach party shall indemnify the other against third party claims from gross negligence [CITE-002].")
    assert "superseded_authority" in seg(r, "indemnify").issues and r.summary()["superseded_cited"] == 1


def test_quote_verification_exact_whitespace_and_typography():
    assert find_quote("terminate for convenience on thirty days written notice", [TERM]).start == TERM.index("terminate")
    assert find_quote("terminate  for\nconvenience on thirty   days written notice", [TERM])        # whitespace ok
    assert find_quote("shall pay all undisputed invoices", ["The Customer “shall pay all undisputed invoices” now."])
    assert find_quote("Customer’s duty to pay everything", ["Customer's duty to pay everything on time"])  # curly apostrophe
    assert find_quote("terminate for convenience on thirty days written NOTICE", [TERM]) is None            # case matters
    assert find_quote("terminate for convenience on sixty days written notice", [TERM]) is None             # wording matters
    assert find_quote("terminate for convenience ... days written notice", [TERM])                          # ellipsis ok
    assert find_quote("written notice ... terminate for convenience", [TERM]) is None                       # order matters
    assert find_quote("short", [TERM]) is None


def test_quotes_in_answers_verified_with_offsets_and_mismatch_flagged():
    r = v('## Analysis\nThe contract says "terminate for convenience on thirty days written notice" [CITE-001]. '
          'It also says "terminate for convenience on ninety days written notice" [CITE-001].')
    good, bad = r.quotes
    assert good["status"] == "verified" and good["cite_id"] == "CITE-001"
    assert good["doc_start"] == 100 + TERM.index("terminate") and good["doc_end"] - good["doc_start"] == len(good["quote"])
    assert bad["status"] == "mismatch"
    assert "quote_not_found_verbatim" in seg(r, "ninety").issues and r.summary()["quotes_failed"] == 1


def test_quote_from_a_different_source_is_flagged():
    r = v('## Analysis\nThe text "shall indemnify the other against third party claims" supports this [CITE-001].')
    assert r.quotes[0]["status"] == "verified" and r.quotes[0]["cite_id"] == "CITE-002"
    assert "quote_from_different_source" in seg(r, "indemnify").issues


def test_extract_quotes_ignores_short_scare_quotes():
    assert extract_quotes('He said "no" and "this exact long phrase appears here".') == ["this exact long phrase appears here"]


# ---- detection ---------------------------------------------------------------------------------------------
def test_detect_governing_law_date_and_class():
    t = ("MASTER SERVICES AGREEMENT dated as of March 3, 2024 between A and B. WHEREAS the parties agree. "
         "This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware. "
         "Termination. Indemnification. governing law.")
    assert detect_jurisdiction(t) == "Delaware" and detect_date(t) == date(2024, 3, 3) and classify(t) == "contract"
    assert detect_jurisdiction("Governed by the laws of North Carolina.") == "North Carolina"
    assert detect_jurisdiction("See 26 U.S.C. 501 for details.") == "United States (Federal)"
    assert detect_jurisdiction("Nothing here.") == "" and detect_date("no date") is None
    assert classify("The plaintiff and the defendant appeared; the court held that the claim fails.") == "case"


def test_normalize_jurisdiction_aliases():
    for a in ("US-DE", "State of Delaware", "delaware", "  DELAWARE "):
        assert normalize_jurisdiction(a) == "delaware"
    assert normalize_jurisdiction("US-FED") == normalize_jurisdiction("Federal") == "federal"
    assert normalize_jurisdiction("US-NC") == "north carolina" and normalize_jurisdiction("") == ""


def test_chunks_feed_validator_end_to_end_offsets():
    doc = parse_document("a.txt", b"ARTICLE I\n\n1.1 Either party may terminate for convenience on thirty days written notice.")
    c = chunk_document(doc)[0]
    ev = [EvidenceItem("CITE-001", "x", c.text, char_start=c.start)]
    r = validate_answer('## Analysis\nThe text "terminate for convenience on thirty days written notice" [CITE-001].', ev)
    q = r.quotes[0]
    assert doc.text[q["doc_start"]:q["doc_end"]] == q["quote"]


def test_segments_carry_line_numbers_for_rendering():
    r = v("## Analysis\nFirst sentence is here and it is long enough. Second sentence follows on.\n\nNext line begins here.")
    assert [s.line for s in r.segments] == [0, 1, 1, 3]


def test_continuation_sentences_and_quote_only_sentences_are_not_false_alarms():
    r = v('## Analysis\nEither party may terminate for convenience on thirty days written notice [CITE-001]. '
          'This provision permits termination without any stated cause by either side.\n'
          'The clause states "terminate for convenience on thirty days written notice" in plain terms here.\n'
          'The agreement also contains a broad indemnification obligation covering all losses.\n'
          '## Contrary or Limiting Authority\nNone identified in the provided sources.')
    assert seg(r, "This provision").status == "continuation"
    q = seg(r, "plain terms")
    assert q.status == "supported" and q.cites == ["CITE-001"]
    assert seg(r, "broad indemnification").status == "uncited"
    assert seg(r, "None identified").status == "n/a"
    assert r.summary()["uncited"] == 1
