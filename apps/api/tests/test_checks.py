from legalai.review.checks import (broken_cross_references, classify_topics, defined_terms, detect_agreement_type,
                                   key_figures, missing_topics, section_numbers, undefined_terms, unused_definitions)

DOC = '''SERVICES AGREEMENT

ARTICLE I DEFINITIONS

1.1 "Confidential Information" means all non-public information disclosed by either party.

1.2 "Services" means the services described in each Statement of Work.

ARTICLE II TERM

2.1 The Vendor shall deliver the Deliverables on the schedule in Section 3.2. Confidential Information must be
protected under Section 9.4 and Exhibit B. The Service Credits apply as set out in Section 2.1(a).

2.2 The Vendor will provide Service Credits if the Deliverables are late; Service Credits are the sole remedy.

ARTICLE III FEES

3.1 Customer shall pay the Fees within thirty (30) days. Late amounts accrue 1.5% per month, up to $50,000.

3.2 Payment terms in Article IV do not apply. Exhibit A lists the Fees.

Exhibit A
Fee schedule.
'''


def test_defined_terms_found_in_quotes_and_parentheticals():
    t = 'This agreement (the "Agreement") is between Acme Corp (the “Customer”). "Services" means work.'
    assert defined_terms(t) == {"Agreement", "Customer", "Services"}


def test_undefined_terms_flag_repeated_undefined_capitalized_terms():
    names = {x["term"] for x in undefined_terms(DOC)}
    assert "Service Credits" in names and "Deliverables" in names or "Service Credits" in names
    assert "Confidential Information" not in names and "Services" not in names


def test_unused_definitions():
    t = '"Orphan Term" means something. "Used Term" means other. The Used Term applies. Used Term again.'
    assert unused_definitions(t) == ["Orphan Term"]


def test_broken_cross_references():
    broken = {b["reference"] for b in broken_cross_references(DOC)}
    assert "Section 9.4" in broken and "Exhibit B" in broken and "Article IV" in broken
    assert "Section 3.2" not in broken and "Section 2.1(a)" not in broken and "Exhibit A" not in broken


def test_external_law_references_are_not_flagged():
    assert broken_cross_references("See Section 501(c) of the Internal Revenue Code and 26 U.S.C. Section 7.") == []


def test_section_numbers_include_parents():
    assert {"2", "2.1", "3.2"} <= section_numbers(DOC)


def test_topics_missing_and_type_detection():
    assert {"payment", "confidentiality"} <= set(classify_topics(DOC))
    miss = missing_topics(DOC, "contract")
    assert "limitation_of_liability" in miss and "governing_law_forum" in miss and "payment" not in miss
    assert detect_agreement_type("MUTUAL NON-DISCLOSURE AGREEMENT between...") == "nda"
    assert detect_agreement_type("Master Subscription Agreement for SaaS") == "saas"
    assert detect_agreement_type("Services agreement") == "contract"


def test_key_figures():
    f = key_figures(DOC)
    assert "$50,000" in f.money and any("30" in d for d in f.durations) and "1.5%" in f.percents


def test_generic_phrases_starting_with_common_words_are_not_flagged_as_undefined():
    t = "This Agreement applies. This Agreement ends. The Parties agree. The Parties sign. Each Party acts. Each Party signs."
    assert undefined_terms(t) == []
