import io
import zipfile

import pytest

from legalai.ingestion.chunking import chunk_document
from legalai.ingestion.parsers import NeedsOcr, ParseError, parse_document

CONTRACT = """MASTER SERVICES AGREEMENT

ARTICLE I DEFINITIONS

1.1 Confidential Information means all non-public information disclosed by either party.

1.2 Services means the services described in each Statement of Work.

ARTICLE II TERM AND TERMINATION

2.1 Term. This Agreement begins on the Effective Date and continues for two years unless terminated earlier.

(a) Either party may terminate for convenience on thirty days written notice.

(b) Either party may terminate immediately if the other party materially breaches and fails to cure within fifteen days.

2.2 Payment. Customer shall pay all undisputed invoices within thirty days of receipt.

ARTICLE III INDEMNITY

3.1 Each party shall indemnify the other against third party claims arising from its gross negligence.
"""


def _pdf(text: str) -> bytes:
    """Hand-built single-page PDF with a real text layer."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, x)
    return out


def _docx(paras: list[tuple[str, str | None]]) -> bytes:
    body = "".join(
        f'<w:p>{f"<w:pPr><w:pStyle w:val=\"{st}\"/></w:pPr>" if st else ""}<w:r><w:t>{t}</w:t></w:r></w:p>' for t, st in paras)
    xml = f'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("word/document.xml", xml)
    return b.getvalue()


def test_chunk_invariant_and_structure():
    doc = parse_document("a.txt", CONTRACT.encode())
    chunks = chunk_document(doc)
    assert chunks
    for c in chunks:
        assert doc.text[c.start:c.end] == c.text            # exact source slice, always
        assert c.text_hash and c.text.strip()
    by_text = {c.text[:20]: c for c in chunks}
    term = next(c for c in chunks if "terminate for convenience" in c.text)
    assert term.heading_path[0].startswith("ARTICLE II")
    indem = next(c for c in chunks if "indemnify" in c.text)
    assert indem.heading_path[0].startswith("ARTICLE III") and "ARTICLE II " not in " ".join(indem.heading_path)
    assert "MASTER" not in indem.text and by_text


def test_long_paragraph_split_with_overlap_and_exact_offsets():
    sent = "The quick brown fox jumps over the lazy dog near the riverbank today. "
    doc = parse_document("long.txt", (sent * 80).encode())
    chunks = chunk_document(doc)
    assert len(chunks) > 1
    for c in chunks:
        assert doc.text[c.start:c.end] == c.text and len(c.text) <= 2000
    assert chunks[1].start < chunks[0].end  # one-sentence overlap


def test_pdf_pages_and_text():
    doc = parse_document("x.pdf", _pdf("Governing law is Delaware. The parties agree to arbitration."))
    assert doc.page_count == 1 and "Delaware" in doc.text
    assert chunk_document(doc)[0].page == 1


def test_scanned_pdf_needs_ocr_and_images_need_ocr():
    with pytest.raises(NeedsOcr):
        parse_document("scan.pdf", _pdf(""))
    with pytest.raises(NeedsOcr):
        parse_document("scan.png", b"\x89PNG\r\n\x1a\n")


def test_corrupt_pdf_raises_parse_error():
    with pytest.raises(ParseError):
        parse_document("bad.pdf", b"%PDF-1.4 garbage")


def test_docx_headings_become_path():
    data = _docx([("Confidentiality", "Heading1"), ("Each party keeps secrets.", None),
                  ("Term", "Heading1"), ("Two years.", None)])
    chunks = chunk_document(parse_document("a.docx", data))
    assert [c.heading_path for c in chunks] == [["Confidentiality"], ["Term"]]


def test_docx_xml_bomb_rejected():
    evil = ('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>')
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("word/document.xml", evil)
    with pytest.raises(Exception):
        parse_document("evil.docx", b.getvalue())


def test_html_strips_scripts_and_uses_headings():
    html = b"<html><head><title>x</title><script>alert(1)</script></head><body><h1>Payment</h1><p>Pay in 30 days.</p></body></html>"
    doc = parse_document("a.html", html)
    assert "alert" not in doc.text and chunk_document(doc)[0].heading_path == ["Payment"]


def test_markdown_headings_and_eml():
    md = b"# Term\n\nTwo years.\n\n## Renewal\n\nAuto renews."
    chunks = chunk_document(parse_document("a.md", md))
    assert chunks[1].heading_path == ["Term", "Renewal"]
    eml = b"From: a@x.com\nTo: b@x.com\nSubject: Hello\nContent-Type: text/plain\n\nPlease sign the NDA."
    d = parse_document("m.eml", eml)
    assert "Subject: Hello" in d.text and "sign the NDA" in d.text


def test_numbered_provisions_are_separate_chunks_subclauses_stay_with_parent():
    doc = parse_document("a.txt", CONTRACT.encode())
    chunks = chunk_document(doc)
    term = next(c for c in chunks if c.text.startswith("2.1 Term"))
    assert "(a) Either party may terminate" in term.text and "2.2 Payment" not in term.text
    pay = next(c for c in chunks if c.text.startswith("2.2 Payment"))
    assert pay.section_number == "2.2" and term.section_number == "2.1"
    for c in chunks:
        assert doc.text[c.start:c.end] == c.text
