import json

from legalai.db import session_scope
from legalai.models import Document
from legalai.startup.catalog import CHECKLIST, DOC_TYPES, build_instructions, doc_type
from tests.test_review import ReviewLLM
from tests.test_retrieval import drain, emb, mk_matter, upload  # noqa: F401

FOUNDERS = ("FOUNDERS AGREEMENT\n\n1. Ownership. Ann and Bo each own 50% of the shares.\n\n2. Governing Law. Delaware law applies.\n\n"
            "3. Confidentiality. Each founder keeps the company's information confidential.")


def onboard(a, entity="llc", state="Delaware"):
    r = a.post("/api/onboarding", json={"company_name": "Acme Labs", "entity_type": entity, "state": state})
    assert r.status_code == 201, r.text
    return r.json()["matter_id"]


def test_catalog_is_consistent():
    ids = {d["id"] for d in DOC_TYPES}
    assert len(ids) == len(DOC_TYPES) and all(c["draft"] in ids for c in CHECKLIST if c.get("draft"))
    for d in DOC_TYPES:
        keys = [f["key"] for f in d["fields"]]
        assert len(keys) == len(set(keys)) and d["outline"] and d["guidance"] and any(f["required"] for f in d["fields"])
    text, facts = build_instructions(doc_type("founders_agreement"), {"company_name": "Acme", "equity_split": "", "founders": "Ann\nBo"})
    assert "1. Parties and purpose" in text and "[\u25cfPLACEHOLDER]" in text and facts == {"Company name": "Acme", "Founders (full names)": "Ann\nBo"}


def test_catalog_endpoint_and_onboarding_creates_one_company_workspace(make_api):
    a = make_api("admin@example.com")
    c = a.get("/api/startup/catalog").json()
    assert len(c["doc_types"]) == len(DOC_TYPES) and "Delaware" in c["states"] and c["checklist"]
    mid = onboard(a)
    assert a.post("/api/onboarding", json={"company_name": "Again", "entity_type": "llc"}).status_code == 409
    m = a.get(f"/api/matters/{mid}").json()
    assert m["profile"]["company"] is True and m["jurisdiction"] == "Delaware" and m["privacy_mode"] in ("private", "standard", "local_only")
    assert a.patch(f"/api/matters/{mid}/profile", json={"state": "North Carolina"}).json()["profile"]["state"] == "North Carolina"
    assert a.get(f"/api/matters/{mid}").json()["jurisdiction"] == "North Carolina"
    bob = make_api("bob@example.com")
    assert bob.get(f"/api/matters/{mid}/checklist").status_code == 404 and bob.patch(f"/api/matters/{mid}/profile", json={"stage": "x"}).status_code == 404


def test_checklist_follows_entity_type_and_detects_uploaded_documents(make_api, emb):
    a = make_api("admin@example.com")
    mid = onboard(a, "llc")
    cl = a.get(f"/api/matters/{mid}/checklist").json()
    ids = {i["id"] for i in cl["items"]}
    assert "operating_agreement" in ids and "bylaws" not in ids and cl["done"] == 0
    upload(a, mid, "founders.txt", FOUNDERS.encode())
    drain()
    with session_scope() as db:
        assert db.query(Document).one().agreement_type == "founders_agreement"
    cl = a.get(f"/api/matters/{mid}/checklist").json()
    fa = next(i for i in cl["items"] if i["id"] == "founders_agreement")
    assert fa["status"] == "done" and fa["detected"] and fa["documents"][0]["title"] == "founders.txt" and cl["done"] == 1
    assert a.put(f"/api/matters/{mid}/checklist/formation", json={"status": "done"}).status_code == 200
    assert a.put(f"/api/matters/{mid}/checklist/fundraising", json={"status": "not_needed"}).status_code == 200
    assert a.put(f"/api/matters/{mid}/checklist/nope", json={"status": "done"}).status_code == 404
    cl = a.get(f"/api/matters/{mid}/checklist").json()
    assert next(i for i in cl["items"] if i["id"] == "formation")["status"] == "done" and cl["done"] == 2
    carol = make_api("carol@example.com")
    corp = onboard(carol, "delaware_c_corp")
    cids = {i["id"] for i in carol.get(f"/api/matters/{corp}/checklist").json()["items"]}
    assert "bylaws" in cids and "operating_agreement" not in cids


def test_wizard_draft_uses_catalog_outline_and_requires_answers(make_api, emb):
    a = make_api("admin@example.com")
    mid = onboard(a, "delaware_c_corp")
    r = a.post("/api/drafts", json={"matter_id": mid, "catalog_id": "founders_agreement", "answers": {"company_name": "Acme"}})
    assert r.status_code == 422 and "Founders" in r.json()["detail"]
    assert a.post("/api/drafts", json={"matter_id": mid, "catalog_id": "nope", "answers": {}}).status_code == 404
    r = a.post("/api/drafts", json={"matter_id": mid, "catalog_id": "nda_mutual", "answers": {"party_a": "Acme", "party_b": "Globex", "purpose": "Partnership talks", "state": "Delaware"}})
    assert r.status_code == 202, r.text
    llm = ReviewLLM()
    drain(llm)
    d = a.get(f"/api/drafts/{r.json()['id']}").json()
    assert d["status"] == "complete" and d["doc_type"] == "Mutual NDA"
    prompt = next(ms for k, ms in llm.calls if k == "draft")[-1]["content"]
    assert "1. Purpose" in prompt and "Globex" in prompt and "Governing law (state)" in prompt            # outline and the user's facts reach the model
    assert d["inputs"]["catalog_id"] == "nda_mutual" and d["inputs"]["outline"]


def test_templates_in_the_library_guide_catalog_drafts_with_attribution(make_api, emb, monkeypatch):
    from datetime import date
    from tests.test_corpus import FakeAdapter
    a = make_api("admin@example.com")
    nda_text = "MUTUAL NDA\n\n1. Purpose. The parties may share confidential information to evaluate a business relationship.\n\n2. Obligations. Each party shall protect the other party's confidential information.\n\n" * 3
    from datetime import datetime, timezone
    from legalai.corpus.adapters import FetchResult

    class CfgAdapter:                                   # like the real URL adapter: title and citation come from the source config
        async def run(self, cfg, etag=None):
            return FetchResult(content=nda_text.encode(), filename="nda.txt", title=cfg["title"], citation=cfg["citation"], effective_from=date(2024, 1, 1),
                               source_url=cfg["url"], retrieved_at=datetime.now(timezone.utc))
    monkeypatch.setattr("legalai.corpus.refresh.build_adapter", lambda name: CfgAdapter())
    r = a.post("/api/library/sources", json={"name": "Common Paper Mutual NDA", "adapter": "url", "authority_type": "template",
                                              "config": {"url": "https://commonpaper.com/standards/mutual-nda/", "title": "Common Paper Mutual NDA (template)",
                                                         "citation": "Common Paper Mutual NDA, licensed CC BY 4.0", "official": False}})
    assert r.status_code == 201, r.text
    drain()
    lib = a.get("/api/library").json()["documents"][0]
    assert lib["authority_type"] == "template" and lib["official_source"] is False                  # not marked as an official government source
    mid = onboard(a)
    r = a.post("/api/drafts", json={"matter_id": mid, "catalog_id": "nda_mutual", "answers": {"party_a": "Acme", "party_b": "Globex", "purpose": "Talks", "state": "Delaware"}})
    llm = ReviewLLM()
    drain(llm)
    d = a.get(f"/api/drafts/{r.json()['id']}").json()
    assert [x["kind"] for x in d["result"]["reference"]].count("template") >= 1
    assert d["result"]["attribution"] == ["Common Paper Mutual NDA, licensed CC BY 4.0"]
    assert "TEMPLATE: Common Paper Mutual NDA" in next(ms for k, ms in llm.calls if k == "draft")[-1]["content"]


def test_states_and_cases_catalog_endpoints(make_api, emb, monkeypatch, tmp_path):
    import legalai.routers.library as lib
    root = tmp_path / "corpus"
    root.mkdir()
    (root / "states.json").write_text(json.dumps({"generated": "2026-10-02", "states": {
        "ZZ": {"name": "Zedland", "code": "ZZ", "kinds": {
            "llc": {"title": "Zedland LLC Act", "citation": "Z.C. ch. 1", "label": "LLC Act", "caveat": True, "notes": "Session law, later amendments missing",
                    "items": [{"name": "Whole act", "url": "https://legis.zedland.gov/llc", "text_chars": 90000}]},
            "corp": {"title": "Zedland Corporation Act", "citation": "Z.C. ch. 2", "label": "Corporation Act", "caveat": False, "notes": "No static official text", "items": []}}}}}))
    (root / "cases.json").write_text(json.dumps([{"group": "Delaware corporate duties", "name": "Smith v. Van Gorkom", "opinion_id": 1479784, "case_name": "Smith v. Van Gorkom",
                                                  "citation": "488 A.2d 858", "decided": "1985-03-14", "chars": 144395}]))
    monkeypatch.setattr(lib, "_CORPUS", root)
    monkeypatch.setattr("legalai.corpus.refresh.build_adapter", lambda name: __import__("tests.test_corpus", fromlist=["FakeAdapter"]).FakeAdapter("Section 1.1 A long enough statute text. " * 20, __import__("datetime").date(2024, 1, 1)))
    a = make_api("admin@example.com")
    st = a.get("/api/library/states").json()["states"]
    z = st[0]
    assert z["name"] == "Zedland" and z["kinds"]["llc"]["available"] and z["kinds"]["llc"]["caveat"].startswith("Session law")
    assert z["kinds"]["corp"]["available"] is False and "No static official text" in z["kinds"]["corp"]["caveat"]
    assert a.post("/api/library/states/ZZ", json={"kinds": ["llc", "corp"]}).json() == {"created": 1, "skipped_existing": 0}
    assert a.post("/api/library/states/ZZ", json={}).json() == {"created": 0, "skipped_existing": 1}          # idempotent
    assert a.get("/api/library/states").json()["states"][0]["kinds"]["llc"]["added"] is True
    assert a.post("/api/library/states/QQ", json={}).status_code == 404
    cs = a.get("/api/library/cases").json()
    assert cs["groups"][0]["cases"][0]["added"] is False
    assert a.post("/api/library/cases", json={"group": "Delaware corporate duties"}).json() == {"created": 1}
    assert a.post("/api/library/cases", json={"group": "Delaware corporate duties"}).json() == {"created": 0}
    assert a.post("/api/library/cases", json={"group": "nope"}).status_code == 404
    bob = make_api("bob@example.com")
    assert bob.get("/api/library/states").status_code == 403 and bob.post("/api/library/states/ZZ", json={}).status_code == 403
    assert bob.get("/api/library/cases").status_code == 403


def test_template_presets_are_present_and_marked_unofficial():
    from legalai.corpus.adapters import validate_config
    from legalai.corpus.presets import PRESETS
    g = next(p for p in PRESETS if p["id"] == "common-paper-templates")
    assert g["authority_type"] == "template" and len(g["items"]) == 8
    for it in g["items"]:
        cfg = validate_config("url", it["config"])
        assert cfg["official"] is False and "CC BY 4.0" in cfg["citation"] and cfg["url"].startswith("https://commonpaper.com/standards/")


def test_finished_draft_can_be_downloaded_and_saved_as_a_document(make_api, emb):
    import io
    from docx import Document as Docx
    a = make_api("admin@example.com")
    mid = onboard(a)
    r = a.post("/api/drafts", json={"matter_id": mid, "catalog_id": "nda_mutual", "answers": {"party_a": "Acme", "party_b": "Globex", "purpose": "Talks", "state": "Delaware"}})
    did = r.json()["id"]
    assert a.get(f"/api/drafts/{did}/download").status_code == 409 and a.post(f"/api/drafts/{did}/save").status_code == 409     # not finished yet
    drain(ReviewLLM())
    w = a.get(f"/api/drafts/{did}/download?format=docx")
    assert w.status_code == 200 and w.headers["content-disposition"].endswith('Mutual-NDA.docx"')
    assert "SERVICES AGREEMENT" in " ".join(p.text for p in Docx(io.BytesIO(w.content)).paragraphs)
    assert a.get(f"/api/drafts/{did}/download?format=txt").content.decode().startswith("SERVICES AGREEMENT")
    saved = a.post(f"/api/drafts/{did}/save").json()
    drain()
    docs = a.get(f"/api/matters/{mid}/documents").json()
    assert [d["title"] for d in docs] == ["Mutual NDA"] and docs[0]["current_version"]["parse_status"] == "parsed"
    bob = make_api("bob@example.com")
    assert bob.get(f"/api/drafts/{did}/download").status_code == 404 and bob.post(f"/api/drafts/{did}/save").status_code == 404
