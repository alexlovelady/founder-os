import io
import socket
import struct
import threading
import zipfile

import pytest

from legalai.config import get_settings
from legalai.scanning import ClamdScanner, ScannerUnavailable, builtin_scan, scan_upload
from legalai.storage import UploadRejected
from tests.test_retrieval import mk_matter


def zipped(files: dict) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


def test_builtin_rejections():
    eicar = rb"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    bad = {"eicar.txt": eicar, "x.txt": b"MZ\x90\x00 pretend text", "x.pdf": b"%PDF-1.4 /OpenAction << /S /JavaScript /JS (app.alert(1)) >>",
           "x2.pdf": b"%PDF-1.4 << /Launch /Win >>", "x3.pdf": b"%PDF-1.4 /EmbeddedFile",
           "m.docx": zipped({"word/document.xml": "<w:document/>", "word/vbaProject.bin": b"x"}),
           "a.docx": zipped({"word/document.xml": "<w:document/>", "word/activeX/activeX1.xml": "<x/>"}),
           "t.docx": zipped({"word/document.xml": "<w:document/>", "../../evil.sh": "rm -rf"}),
           "e.txt": b"\x7fELF binary"}
    for name, data in bad.items():
        with pytest.raises(UploadRejected):
            builtin_scan(name, data)


def test_builtin_accepts_normal_documents():
    for name, data in {"a.txt": b"Plain contract text", "a.pdf": b"%PDF-1.4 /Type /Page BT (hello) Tj ET",
                       "a.docx": zipped({"word/document.xml": "<w:document/>", "word/media/image1.png": b"\x89PNG"}),
                       "a.html": b"<html><body>hi</body></html>"}.items():
        builtin_scan(name, data)
    assert scan_upload("a.txt", b"hello").scanner == "builtin"


def fake_clamd(reply: bytes):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    got = {}

    def run():
        c, _ = srv.accept()
        buf = b""
        while not buf.endswith(struct.pack("!I", 0)):
            part = c.recv(65536)
            if not part:
                break
            buf += part
        got["buf"] = buf
        c.sendall(reply)
        c.close()
        srv.close()
    threading.Thread(target=run, daemon=True).start()
    return srv.getsockname()[1], got


def test_clamd_protocol_clean_and_infected():
    port, got = fake_clamd(b"stream: OK\0")
    ClamdScanner("127.0.0.1", port).scan(b"hello world")
    assert got["buf"].startswith(b"zINSTREAM\0") and b"hello world" in got["buf"]
    port, _ = fake_clamd(b"stream: Win.Test.EICAR_HDB-1 FOUND\0")
    with pytest.raises(UploadRejected, match="EICAR"):
        ClamdScanner("127.0.0.1", port).scan(b"x")
    port, _ = fake_clamd(b"stream: ERROR\0")
    with pytest.raises(ScannerUnavailable):
        ClamdScanner("127.0.0.1", port).scan(b"x")


def test_clamd_unreachable_fails_closed_only_when_required(monkeypatch):
    monkeypatch.setenv("CLAMAV_HOST", "127.0.0.1")
    monkeypatch.setenv("CLAMAV_PORT", "1")
    get_settings.cache_clear()
    assert scan_upload("a.txt", b"hello").scanner == "clamav_unavailable"
    monkeypatch.setenv("CLAMAV_REQUIRED", "true")
    get_settings.cache_clear()
    with pytest.raises(UploadRejected, match="unavailable"):
        scan_upload("a.txt", b"hello")


def test_upload_endpoint_rejects_malware_and_audits_it(make_api):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    eicar = rb"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    r = a.post("/api/documents", data={"matter_id": m["id"]}, files={"file": ("virus.txt", eicar)})
    assert r.status_code == 422 and "antivirus" in r.json()["detail"]
    assert a.get(f"/api/matters/{m['id']}/documents").json() == []
    assert "document.upload_rejected" in {e["action"] for e in a.get(f"/api/matters/{m['id']}/audit").json()}
    ok = a.post("/api/documents", data={"matter_id": m["id"]}, files={"file": ("ok.txt", b"A normal contract clause here.")})
    assert ok.status_code == 201
    acts = [e for e in a.get(f"/api/matters/{m['id']}/audit").json() if e["action"] == "document.uploaded"]
    assert acts[0]["detail"]["scanned_by"] == "builtin"
