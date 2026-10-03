"""Upload scanning. Always-on built-in checks (no external service) plus optional ClamAV via the clamd protocol.

Built-in checks reject: the EICAR antivirus test file, executables disguised as documents, Office files with macros or
ActiveX, zip entries that try path traversal, and PDFs with launch actions, embedded JavaScript or embedded files.
ClamAV (set CLAMAV_HOST) adds signature scanning; with CLAMAV_REQUIRED=true an unreachable scanner rejects uploads
(fail closed), otherwise it is logged and the built-in verdict stands."""
import io
import re
import socket
import struct
import zipfile
from dataclasses import dataclass

from .config import get_settings
from .storage import UploadRejected

EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
EXEC_MAGIC = (b"MZ", b"\x7fELF", b"\xca\xfe\xba\xbe", b"\xcf\xfa\xed\xfe", b"#!/")
OFFICE_ACTIVE = ("vbaproject.bin", "activex", "macrosheets", "oleobject")
PDF_ACTIVE = re.compile(rb"/(Launch|JavaScript|JS|EmbeddedFile|RichMedia)\b")


class ScannerUnavailable(Exception):
    pass


@dataclass
class ScanResult:
    scanner: str  # builtin | clamav | clamav_unavailable


def builtin_scan(filename: str, data: bytes) -> None:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if EICAR in data:
        raise UploadRejected("File matches the antivirus test signature")
    if any(data.startswith(m) for m in EXEC_MAGIC):
        raise UploadRejected("File content is an executable, not a document")
    if ext == "docx" or data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for name in z.namelist():
                    low = name.lower()
                    if low.startswith("/") or ".." in low.replace("\\", "/").split("/"):
                        raise UploadRejected("Archive contains an unsafe path")
                    if any(k in low for k in OFFICE_ACTIVE):
                        raise UploadRejected("Documents with macros or embedded active content are not accepted")
        except zipfile.BadZipFile:
            pass  # content validation reports invalid DOCX separately
    if ext == "pdf" or data.lstrip()[:5] == b"%PDF-":
        m = PDF_ACTIVE.search(data)
        if m:
            raise UploadRejected(f"PDF contains active content ({m.group(1).decode()}); export a flattened copy and upload that")


class ClamdScanner:
    def __init__(self, host: str, port: int = 3310, timeout: float = 20):
        self.host, self.port, self.timeout = host, port, timeout

    def scan(self, data: bytes) -> None:
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as s:
                s.sendall(b"zINSTREAM\0")
                for i in range(0, len(data), 64 * 1024):
                    chunk = data[i:i + 64 * 1024]
                    s.sendall(struct.pack("!I", len(chunk)) + chunk)
                s.sendall(struct.pack("!I", 0))
                resp = b""
                while not resp.endswith(b"\0") and len(resp) < 4096:
                    part = s.recv(1024)
                    if not part:
                        break
                    resp += part
        except OSError as e:
            raise ScannerUnavailable(type(e).__name__) from e
        text = resp.strip(b"\0").decode(errors="replace")
        if text.endswith("FOUND"):
            raise UploadRejected(f"Malware detected ({text.split(':', 1)[-1].replace('FOUND', '').strip()})")
        if not text.endswith("OK"):
            raise ScannerUnavailable(f"unexpected scanner reply: {text[:80]}")


def scan_upload(filename: str, data: bytes) -> ScanResult:
    builtin_scan(filename, data)
    s = get_settings()
    if not s.clamav_host:
        return ScanResult("builtin")
    try:
        ClamdScanner(s.clamav_host, s.clamav_port).scan(data)
        return ScanResult("clamav")
    except ScannerUnavailable as e:
        if s.clamav_required:
            raise UploadRejected("The virus scanner is unavailable, so the upload was refused. Try again shortly.") from e
        return ScanResult("clamav_unavailable")
