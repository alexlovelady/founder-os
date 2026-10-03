import io

import pytest

from legalai.config import get_settings
from legalai.ingestion.ocr import ocr_available, ocr_image, ocr_pdf
from tests.test_research import GOOD, ScriptedLLM, finish, start  # noqa: F401
from tests.test_retrieval import drain, emb, mk_matter, upload  # noqa: F401

needs_tesseract = pytest.mark.skipif(not ocr_available(get_settings()), reason="tesseract not installed")
TEXT = ["TERMINATION", "Either party may terminate this agreement", "for convenience on thirty days written notice."]


def page_image(lines=TEXT, size=44):
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("arial.ttf", size)
    except OSError:
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", size)
        except OSError:
            font = ImageFont.load_default(size=size)
    img = Image.new("RGB", (1500, 120 + 80 * len(lines)), "white")
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        d.text((60, 50 + i * 80), line, fill="black", font=font)
    return img


def png(img) -> bytes:
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def scanned_pdf(pages=2) -> bytes:
    import pymupdf
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=612, height=792)
        page.insert_image(pymupdf.Rect(20, 20, 592, 300), stream=png(page_image([f"Section {i + 1}", *TEXT[1:]])))
    return doc.tobytes()


@needs_tesseract
def test_real_ocr_on_image_and_scanned_pdf():
    s = get_settings()
    r = ocr_image(png(page_image()), s)
    assert "terminate" in r.doc.text.lower() and "thirty days" in r.doc.text.lower() and r.confidence > 60
    p = ocr_pdf(scanned_pdf(2), s)
    assert p.doc.page_count == 2 and {b.page for b in p.doc.blocks} == {1, 2}
    assert "written notice" in p.doc.text.lower()


@needs_tesseract
def test_scanned_pdf_flows_through_ocr_job_search_and_labels(make_api, emb):
    a = make_api("admin@example.com")
    m = mk_matter(a, "standard")
    d = upload(a, m["id"], "scan.pdf", scanned_pdf(1))
    drain()
    v = a.get(f"/api/documents/{d['id']}/versions").json()[0]
    assert v["parse_status"] == "parsed" and v["ocr_applied"] is True and v["ocr_confidence"] > 50 and "OCR" in v["parse_error"]
    hits = a.post(f"/api/matters/{m['id']}/search", json={"query": "terminate for convenience thirty days written notice"}).json()["hits"]
    assert hits and hits[0]["page"] == 1
    acts = {e["action"] for e in a.get(f"/api/matters/{m['id']}/audit").json()}
    assert {"document.ocr_queued", "document.parsed"} <= acts
    run = finish(a, start(a, m["id"], "How can the agreement be terminated for convenience?"), ScriptedLLM([GOOD]))
    assert "Some sources are OCR text" in [c["label"] for c in run["result"]["coverage"]]
    assert run["result"]["evidence"][0]["ocr"] is True


def test_without_ocr_scanned_documents_are_flagged_clearly(make_api, emb, monkeypatch):
    monkeypatch.setenv("OCR_ENABLED", "false")
    get_settings.cache_clear()
    a = make_api("admin@example.com")
    m = mk_matter(a)
    import pymupdf
    doc = pymupdf.open()
    doc.new_page()
    d = upload(a, m["id"], "blank.pdf", doc.tobytes())
    drain()
    v = a.get(f"/api/documents/{d['id']}/versions").json()[0]
    assert v["parse_status"] == "needs_ocr" and "not available" in v["parse_error"]


def test_ocr_failure_is_recorded_not_crashed(make_api, emb, monkeypatch):
    monkeypatch.setattr("legalai.ingestion.ocr.ocr_available", lambda s: True)
    monkeypatch.setattr("legalai.ingestion.pipeline.ocr_available", lambda s: True)
    from legalai.ingestion.parsers import NeedsOcr

    def blank(name, data, s):
        raise NeedsOcr("OCR found no readable text")
    monkeypatch.setattr("legalai.ingestion.ocr.ocr_document", blank)
    a = make_api("admin@example.com")
    m = mk_matter(a)
    import pymupdf
    doc = pymupdf.open()
    doc.new_page()
    d = upload(a, m["id"], "blank.pdf", doc.tobytes())
    drain()
    v = a.get(f"/api/documents/{d['id']}/versions").json()[0]
    assert v["parse_status"] == "failed" and "OCR failed" in v["parse_error"]
