import json

from legalai.critic.critic import deterministic_findings, detect_conflicts, verify_model_findings
from tests.test_research import GOOD, ScriptedLLM, drain, finish, setup, start  # noqa: F401
from tests.test_research import emb  # noqa: F401
from tests.test_review import ReviewLLM, run_review  # noqa: F401

OUT = "Either party may terminate on thirty days notice [CITE-001]. The fee is capped at $10,000 [CITE-002]."
EV = [{"cite_id": "CITE-001", "text": "Either party may terminate on thirty days written notice.", "document_id": "d1", "version_id": "v1",
       "title": "MSA", "flags": [], "jurisdiction": "Delaware"},
      {"cite_id": "CITE-002", "text": "Customer shall pay a fee capped at $20,000 within sixty days of the invoice.", "document_id": "d2",
       "version_id": "v2", "title": "SOW", "flags": ["jurisdiction_mismatch"], "jurisdiction": "Texas"}]


def f(**kw):
    return {"type": "unsupported_proposition", "severity": "high", "quote": "The fee is capped at $10,000",
            "explanation": "CITE-002 says $20,000, not $10,000.", **kw}


def test_model_findings_are_verified_in_code():
    raw = [f(),
           f(type="made_up_type"),                                              # unknown type
           f(quote="a sentence that is not in the output at all"),              # location invented
           f(explanation="CITE-777 says otherwise."),                           # cites outside the evidence
           f(explanation="Under 15 U.S.C. 1692 this is unlawful."),             # new law introduced by the critic
           f(explanation="Smith v. Jones requires more."),                      # new case introduced by the critic
           f(explanation=""),
           "not a dict"]
    kept, dropped = verify_model_findings(raw, OUT, EV)
    assert len(kept) == 1 and dropped == 7 and kept[0].source == "model" and kept[0].severity == "high"


def test_severity_defaults_and_cap():
    kept, _ = verify_model_findings([f(severity="catastrophic")] * 20, OUT, EV)
    assert len(kept) == 10 and kept[0].severity == "medium"


def test_conflict_detector_needs_shared_topic_and_different_figures():
    ev = [{"cite_id": "CITE-001", "text": "The Customer shall pay invoices within thirty days.", "document_id": "a", "version_id": "1"},
          {"cite_id": "CITE-002", "text": "The Customer shall pay each invoice within sixty days.", "document_id": "b", "version_id": "2"},
          {"cite_id": "CITE-003", "text": "The parties keep confidential information for five years.", "document_id": "c", "version_id": "3"},
          {"cite_id": "CITE-004", "text": "The Customer shall pay invoices within thirty days.", "document_id": "d", "version_id": "4"}]
    c = detect_conflicts(ev)
    assert len(c) >= 1 and all(x.type == "possible_source_conflict" and x.source == "deterministic" for x in c)
    assert not any("CITE-003" in x.explanation for x in c)
    assert not any("CITE-001" in x.explanation and "CITE-004" in x.explanation for x in c)   # same figures: no conflict


def test_deterministic_findings_flag_authority_problems():
    cited = [{"cite_id": "CITE-002", "flags": ["jurisdiction_mismatch", "superseded"]}]
    types = {x.type for x in deterministic_findings("See Section 99.9 for details.", EV, cited)}
    assert {"wrong_jurisdiction", "outdated_authority", "broken_cross_reference"} <= types


def test_critic_in_research_run_keeps_only_verified_findings(make_api, emb):
    a, m, _ = setup(make_api)
    llm = ScriptedLLM([GOOD])
    llm.critic_out = json.dumps([
        {"type": "overconfident_language", "severity": "low", "quote": "Yes. Either party may terminate",
         "explanation": "The answer starts with an unqualified Yes although facts about notice delivery are unknown."},
        {"type": "missing_authority", "severity": "high", "quote": "nothing like this in the answer", "explanation": "Invented location."}])
    run = finish(a, start(a, m["id"]), llm)
    c = run["result"]["critic"]
    assert [x["type"] for x in c["findings"] if x["source"] == "model"] == ["overconfident_language"]
    assert c["dropped_unverifiable"] == 1 and "critic" in llm.kinds()


def test_critic_can_be_disabled_and_failure_is_harmless(make_api, emb):
    a, m, _ = setup(make_api)
    llm = ScriptedLLM([GOOD])
    run = finish(a, start(a, m["id"], critic=False), llm)
    assert run["result"]["critic"] is None and "critic" not in llm.kinds()
    llm2 = ScriptedLLM([GOOD])
    llm2.critic_out = "this is not json at all"
    run2 = finish(a, start(a, m["id"]), llm2)
    assert run2["status"] == "complete" and run2["result"]["critic"]["dropped_unverifiable"] == 0


def test_critic_on_contract_review_is_opt_in(make_api, emb):
    a, m, d = setup(make_api)
    rv = run_review(a, d, ReviewLLM())
    assert rv["result"]["critic"] is None
    rv2 = run_review(a, d, ReviewLLM(), critic=True)
    assert rv2["result"]["critic"] is not None and "findings" in rv2["result"]["critic"]
