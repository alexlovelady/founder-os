import json
import random
import re

from legalai.db import session_scope
from legalai.models import DocumentChunk, Obligation, Redline
from legalai.providers.base import ChatResult, LLMProvider
from legalai.review.diff import apply_ops, compare_clauses, word_diff
from tests.test_ingestion import CONTRACT
from tests.test_retrieval import emb, drain, mk_matter, upload  # noqa: F401

QUOTE_OK = "Either party may terminate for convenience on thirty days written notice."


class ReviewLLM(LLMProvider):
    name, external = "local_gpu", False

    def __init__(self):
        self.calls = []

    def kinds(self):
        return [k for k, _ in self.calls]

    async def chat(self, messages, model, **p):
        text = messages[-1]["content"]
        sysm = messages[0]["content"] if messages[0]["role"] == "system" else ""
        if "extracting facts from contract clauses" in text:
            ids = re.findall(r"^\[(CL-\d+)\]", text, re.M)
            out = []
            for i in ids:
                body = text.split(f"[{i}]")[1].split("[CL-")[0]
                ob = []
                if "terminate for convenience" in body:
                    ob = [{"party": "Either party", "obligation": "Give thirty days written notice to terminate for convenience",
                           "trigger": "termination for convenience", "deadline": "thirty days before termination", "recurrence": "", "confidence": "high"}]
                if "pay all undisputed invoices" in body:
                    ob = [{"party": "Customer", "obligation": "Pay undisputed invoices", "trigger": "receipt of invoice",
                           "deadline": "by March 1, 2025", "recurrence": "monthly", "confidence": "medium"}]
                out.append({"clause": i, "topic": "termination" if "terminate" in body else "payment" if "pay" in body else "other",
                            "summary": f"Summary of {i}", "favors": "neutral", "obligations": ob, "rights": [], "unusual": ""})
            kind, content = "extract", json.dumps(out)
        elif "helping a lawyer review" in text:
            term_id = None
            m = re.search(r"^(CL-\d+) \[termination\]", text, re.M)
            term_id = m.group(1) if m else "CL-001"
            kind = "assess"
            content = json.dumps([
                {"clauses": [term_id], "title": "Termination for convenience", "risk": "high", "basis": "general_risk",
                 "why": "Either side can exit on 30 days notice, which weakens revenue predictability.", "favors": "neutral",
                 "quote": "terminate for convenience on thirty days written notice", "suggested_revision":
                 "Either party may terminate for convenience on ninety days written notice.", "playbook_rule": "termination"},
                {"clauses": ["CL-999"], "title": "Hallucinated clause", "risk": "critical", "basis": "general_risk", "why": "Made up.", "quote": ""},
                {"clauses": [term_id], "title": "Fake quote issue", "risk": "low", "basis": "general_risk",
                 "why": "The clause allows termination at will without notice.", "quote": "either side may walk away at any time"},
                {"clauses": [term_id], "title": "No reasoning", "risk": "critical", "basis": "general_risk", "why": ""},
                {"clauses": [], "title": "Weird risk value", "risk": "apocalyptic", "basis": "missing_term", "why": "Something is absent."},
            ])
        elif "legal drafting assistant" in sysm:
            kind = "draft"
            content = json.dumps({"content": "SERVICES AGREEMENT\n\nThis Agreement is between [●CLIENT_NAME] and the Vendor. Fees are $75,000 per year "
                                  "payable within thirty days. The Vendor shall deliver the Deliverables. See Section 12.4.",
                                  "placeholders": [{"name": "CLIENT_NAME", "description": "Legal name of the client"},
                                                   {"name": "NEVER_USED", "description": "x"}],
                                  "assumptions": ["Annual fees assumed"], "needs_attorney_review": ["Fees clause"]})
        elif "Summarize the substantive differences" in text:
            kind, content = "summary", "- Termination notice period changed.\n- Payment terms changed."
        else:
            kind, content = "other", "[]"
        self.calls.append((kind, messages))
        return ChatResult(content, model, 10, 10)

    async def stream(self, *a, **k):  # pragma: no cover
        yield ""

    async def health(self):
        return {"ok": True}

    async def list_models(self):
        return []


def setup(make_api, text=CONTRACT, mode="standard"):
    a = make_api("admin@example.com")
    m = mk_matter(a, mode)
    d = upload(a, m["id"], "msa.txt", text.encode())
    drain()
    return a, m, d


def run_review(a, d, llm, **kw):
    r = a.post("/api/contracts/review", json={"document_id": d["id"], **kw})
    assert r.status_code == 202, r.text
    drain(llm)
    return a.get(f"/api/contracts/reviews/{r.json()['id']}").json()


def test_contract_review_end_to_end_with_verification(make_api, emb):
    a, m, d = setup(make_api)
    llm = ReviewLLM()
    rv = run_review(a, d, llm, playbook_id="builtin:balanced-commercial", perspective="customer")
    assert rv["status"] == "complete" and rv["prompt_version"] == "review-v1" and rv["output_hash"]
    res = rv["result"]
    assert res["perspective"] == "customer" and res["playbook"].startswith("Balanced") and res["agreement_type"] == "contract"
    assert all(c["id"].startswith("CL-") and c["chunk_id"] for c in res["clauses"])
    titles = [i["title"] for i in res["issues"]]
    assert "Termination for convenience" in titles
    # unverifiable output is dropped, not displayed
    assert "Hallucinated clause" not in titles and "No reasoning" not in titles
    good = next(i for i in res["issues"] if i["title"] == "Termination for convenience")
    assert good["quote_verified"] is True and good["suggested_revision"] and good["risk"] == "high"
    fake = next(i for i in res["issues"] if i["title"] == "Fake quote issue")
    assert fake["quote"] == "" and any("not verbatim" in w for w in res["warnings"])
    weird = next(i for i in res["issues"] if i["title"] == "Weird risk value")
    assert weird["risk"] == "medium"                                          # unknown enum values normalized
    # deterministic findings are always surfaced
    assert "limitation_of_liability" in res["missing_terms"]
    assert any(i["basis"] == "missing_term" and "limitation of liability" in i["title"] for i in res["issues"])
    risks = [i["risk"] for i in res["issues"]]
    assert risks == sorted(risks, key=["critical", "high", "medium", "low", "informational"].index)
    # redline proposed from the issue uses the stored clause text as the original, never model text
    rl = a.get(f"/api/matters/{m['id']}/redlines").json()
    assert len(rl) == 1 and rl[0]["proposed"].startswith("Either party may terminate")
    with session_scope() as db:
        chunk = db.get(DocumentChunk, __import__("uuid").UUID(rl[0]["chunk_id"]))
        assert rl[0]["original"] == chunk.text
    assert apply_ops(rl[0]["ops"], "a") == rl[0]["original"] and apply_ops(rl[0]["ops"], "b") == rl[0]["proposed"]
    # obligations with parsed absolute deadline
    obs = a.get(f"/api/matters/{m['id']}/obligations").json()
    assert {o["party"] for o in obs} == {"Either party", "Customer"}
    pay = next(o for o in obs if o["party"] == "Customer")
    assert pay["deadline_date"] == "2025-03-01" and pay["recurrence"] == "monthly" and pay["source_chunk_id"]
    assert a.patch(f"/api/obligations/{pay['id']}", json={"status": "done"}).json()["status"] == "done"
    acts = {e["action"] for e in a.get(f"/api/matters/{m['id']}/audit").json()}
    assert {"contract_review.requested", "contract_review.completed"} <= acts
    # re-running replaces open obligations instead of duplicating them
    run_review(a, d, ReviewLLM())
    assert len(a.get(f"/api/matters/{m['id']}/obligations").json()) == 2 or len(a.get(f"/api/matters/{m['id']}/obligations").json()) == 3


def test_review_requires_parsed_document_and_matter_access(make_api, emb):
    alice, bob = make_api("alice@example.com"), make_api("bob@example.com")
    m = mk_matter(alice)
    bad = upload(alice, m["id"], "bad.pdf", b"%PDF-1.4 garbage")
    drain()
    assert alice.post("/api/contracts/review", json={"document_id": bad["id"]}).status_code == 409
    good = upload(alice, m["id"], "ok.txt", CONTRACT.encode())
    drain()
    assert bob.post("/api/contracts/review", json={"document_id": good["id"]}).status_code == 404
    rid = alice.post("/api/contracts/review", json={"document_id": good["id"]}).json()["id"]
    assert bob.get(f"/api/contracts/reviews/{rid}").status_code == 404 and bob.get(f"/api/matters/{m['id']}/contract-reviews").status_code == 404
    assert alice.post("/api/contracts/review", json={"document_id": good["id"], "playbook_id": "00000000-0000-0000-0000-000000000000"}).status_code == 404


def test_playbooks_are_owner_scoped_and_builtin_listed(make_api, emb):
    alice, bob = make_api("alice@example.com"), make_api("bob@example.com")
    r = alice.post("/api/playbooks", json={"name": "Mine", "perspective": "vendor", "rules": [{"topic": "payment", "preferred": "Net 15"}]})
    assert r.status_code == 201
    pid = r.json()["id"]
    assert any(p["builtin"] for p in alice.get("/api/playbooks").json()) and any(p["id"] == pid for p in alice.get("/api/playbooks").json())
    assert all(p["id"] != pid for p in bob.get("/api/playbooks").json())
    assert bob.delete(f"/api/playbooks/{pid}").status_code == 404 and alice.delete(f"/api/playbooks/{pid}").status_code == 200
    m = mk_matter(alice)
    d = upload(alice, m["id"], "a.txt", CONTRACT.encode())
    drain()
    pid2 = alice.post("/api/playbooks", json={"name": "P2", "rules": [{"topic": "payment", "preferred": "Net 15"}]}).json()["id"]
    rv = run_review(alice, d, ReviewLLM(), playbook_id=pid2)
    assert rv["result"]["playbook"] == "P2"
    bobm = mk_matter(bob)
    bd = upload(bob, bobm["id"], "b.txt", CONTRACT.encode())
    drain()
    assert bob.post("/api/contracts/review", json={"document_id": bd["id"], "playbook_id": pid2}).status_code == 404


def test_word_diff_roundtrip_property():
    rng = random.Random(7)
    words = "the party shall pay within thirty sixty days of receipt notice terminate fees $5,000 per month".split()
    for _ in range(200):
        a = " ".join(rng.choices(words, k=rng.randint(0, 25)))
        b = " ".join(rng.choices(words, k=rng.randint(0, 25)))
        ops = word_diff(a, b)
        assert apply_ops(ops, "a") == a and apply_ops(ops, "b") == b


def test_compare_clauses_classifies_changes_and_figures():
    mk = lambda t, s="": {"chunk_id": t[:5], "text": t, "section": s, "heading_path": [], "page": None}
    a = [mk("2.1 Either party may terminate on thirty days written notice.", "2.1"),
         mk("3.1 Customer shall pay within thirty days. Late fees of 1% apply.", "3.1"),
         mk("5.1 The Vendor shall maintain insurance coverage.", "5.1")]
    b = [mk("2.1 Either party may terminate on sixty days written notice.", "2.1"),
         mk("3.1 Customer shall pay within thirty days. Late fees of 1% apply.", "3.1"),
         mk("6.1 Governed by Delaware law.", "6.1")]
    r = compare_clauses(a, b)
    assert r["counts"] == {"added": 1, "removed": 1, "modified": 1, "unchanged": 1}
    mod = next(c for c in r["changes"] if c["type"] == "modified")
    assert "thirty" in " ".join(o["text"] for o in mod["ops"] if o["op"] == "delete") and "durations" in mod["figure_changes"]
    assert "termination" in mod["topics"]
    assert r["by_topic"]["termination"]["modified"] == 1


def test_comparison_endpoint_summary_job_and_cross_matter_block(make_api, emb):
    a, m, d = setup(make_api)
    v2 = CONTRACT.replace("thirty days written notice", "sixty days written notice").replace("within thirty days of receipt", "within forty-five days of receipt")
    up = upload(a, m["id"], "msa.txt", v2.encode(), document_id=d["id"])
    drain()
    vs = a.get(f"/api/documents/{d['id']}/versions").json()
    r = a.post("/api/comparisons", json={"version_a": vs[0]["id"], "version_b": vs[1]["id"], "summarize": True})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["counts"]["modified"] >= 2 and body["result"]["changes"]
    drain(ReviewLLM())
    assert "Termination notice period" in a.get(f"/api/comparisons/{body['id']}").json()["summary"]
    other = mk_matter(a)
    od = upload(a, other["id"], "o.txt", CONTRACT.encode())
    drain()
    ov = a.get(f"/api/documents/{od['id']}/versions").json()[0]
    assert a.post("/api/comparisons", json={"version_a": vs[0]["id"], "version_b": ov["id"]}).status_code == 404
    bob = make_api("bob@example.com")
    assert bob.get(f"/api/comparisons/{body['id']}").status_code == 404 and bob.get(f"/api/matters/{m['id']}/comparisons").status_code == 404


def test_draft_flags_every_specific_the_user_did_not_provide(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    r = a.post("/api/drafts", json={"matter_id": m["id"], "mode": "draft_from_scratch", "doc_type": "Services Agreement",
                                    "instructions": "Draft a services agreement. Payment within thirty days.", "facts": {"Client": "Acme"}})
    assert r.status_code == 202
    drain(ReviewLLM())
    d = a.get(f"/api/drafts/{r.json()['id']}").json()
    assert d["status"] == "complete" and "[●CLIENT_NAME]" in d["content"] and d["output_hash"]
    chk = d["result"]["checks"]
    assert "$75,000" in " ".join(chk["unverified_specifics"]).replace("$75,000", "$75,000")
    assert not any("thirty days" in s for s in chk["unverified_specifics"])           # provided by the user
    assert "NEVER_USED" in chk["declared_placeholders_missing_from_text"] and chk["placeholders_in_text"] == ["[●CLIENT_NAME]"]
    assert any(b["reference"] == "Section 12.4" for b in chk["broken_cross_references"])
    assert any("specifics you did not provide" in w for w in d["result"]["warnings"])
    assert d["result"]["assumptions"] and d["result"]["needs_attorney_review"]


def test_draft_modes_need_source_and_chunks_are_matter_scoped(make_api, emb):
    alice, bob = make_api("alice@example.com"), make_api("bob@example.com")
    ma, mb = mk_matter(alice), mk_matter(bob)
    d = upload(alice, ma["id"], "a.txt", CONTRACT.encode())
    drain()
    assert bob.post("/api/drafts", json={"matter_id": mb["id"], "mode": "simplify", "instructions": "Make it simple"}).status_code == 422
    with session_scope() as db:
        cid = str(db.query(DocumentChunk).first().id)
    assert bob.post("/api/drafts", json={"matter_id": mb["id"], "mode": "simplify", "instructions": "simple", "chunk_id": cid}).status_code == 404
    assert bob.post("/api/redlines", json={"chunk_id": cid, "instruction": "make it fair"}).status_code == 404
    assert bob.get("/api/matters/%s/drafts" % ma["id"]).status_code == 404


def test_redline_generation_job_and_status(make_api, emb):
    a, m, d = setup(make_api)
    with session_scope() as db:
        c = db.query(DocumentChunk).filter(DocumentChunk.text.like("%terminate for convenience%")).first()
        cid, original = str(c.id), c.text
    r = a.post("/api/redlines", json={"chunk_id": cid, "instruction": "Extend the notice period", "perspective": "customer"})
    assert r.status_code == 202 and r.json()["proposed"] is None
    llm = ReviewLLM()
    llm_draft = llm.chat  # redline generation uses the drafting prompt
    drain(llm)
    rl = a.get(f"/api/redlines/{r.json()['id']}").json()
    assert rl["original"] == original and rl["proposed"] and rl["generation"] == "complete"
    assert apply_ops(rl["ops"], "a") == original and apply_ops(rl["ops"], "b") == rl["proposed"]
    assert a.patch(f"/api/redlines/{rl['id']}", json={"status": "accepted"}).json()["status"] == "accepted"
    assert a.patch(f"/api/redlines/{rl['id']}", json={"status": "weird"}).status_code == 422


def test_startup_document_gets_its_matching_playbook_automatically(make_api, emb):
    founders = ("FOUNDERS AGREEMENT\n\n1. Ownership. Ann and Bo each own 50% of the shares.\n\n2. Governing Law. Delaware law applies.\n\n"
                "3. Confidentiality. Each founder keeps the company's information confidential.")
    a = make_api("admin@example.com")
    m = mk_matter(a, "standard")
    d = upload(a, m["id"], "founders.txt", founders.encode())
    drain()
    rv = run_review(a, d, ReviewLLM())
    r = rv["result"]
    assert r["agreement_type"] == "founders_agreement" and r["playbook_auto"] is True and r["playbook"].startswith("Founders agreement")
    assert {"vesting", "background_ip_assignment", "departure_and_buyout"} <= set(r["missing_terms"])
    assert any(i["basis"] == "missing_term" and "vesting" in i["title"] for i in r["issues"])
    explicit = run_review(a, d, ReviewLLM(), playbook_id="builtin:balanced-commercial")["result"]
    assert explicit["playbook_auto"] is False and explicit["playbook"].startswith("Balanced")
    names = [p["id"] for p in a.get("/api/playbooks").json() if p["builtin"]]
    assert {"builtin:founders-agreement", "builtin:operating-agreement", "builtin:safe-note", "builtin:contractor-ip"} <= set(names)
