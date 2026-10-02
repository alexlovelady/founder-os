"""Document file storage (Railway volume by default) plus upload validation.
Storage is addressed by key so it can later move to S3-compatible storage without touching callers."""
import hashlib
import io
import os
import re
import zipfile
from pathlib import Path
from typing import Protocol

from .config import get_settings

ALLOWED = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain",
    "md": "text/markdown",
    "html": "text/html",
    "htm": "text/html",
    "eml": "message/rfc822",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "tif": "image/tiff",
    "tiff": "image/tiff",
}


class UploadRejected(Exception):
    pass


def sanitize_filename(name: str) -> str:
    name = os.path.basename(name.replace("\\", "/"))
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip(" .")
    name = re.sub(r"\.{2,}", ".", name)
    return (name or "upload")[:200]


def extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def validate_upload(filename: str, data: bytes) -> str:
    """Check extension is allowed and content matches it. Returns the content type."""
    ext = extension(filename)
    if ext not in ALLOWED:
        raise UploadRejected(f"File type '.{ext}' is not supported")
    if not data:
        raise UploadRejected("Empty file")
    if ext == "pdf" and not data.lstrip()[:5] == b"%PDF-":
        raise UploadRejected("File is not a valid PDF")
    if ext == "docx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if "word/document.xml" not in z.namelist():
                    raise UploadRejected("File is not a valid DOCX")
                if sum(i.file_size for i in z.infolist()) > 500 * 1024 * 1024:
                    raise UploadRejected("DOCX expands to an unreasonable size")
        except zipfile.BadZipFile:
            raise UploadRejected("File is not a valid DOCX")
    if ext == "png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise UploadRejected("File is not a valid PNG")
    if ext in ("jpg", "jpeg") and not data.startswith(b"\xff\xd8\xff"):
        raise UploadRejected("File is not a valid JPEG")
    if ext in ("tif", "tiff") and data[:4] not in (b"II*\x00", b"MM\x00*"):
        raise UploadRejected("File is not a valid TIFF")
    if ext in ("txt", "md", "html", "htm", "eml"):
        if b"\x00" in data[:8192]:
            raise UploadRejected("Text file contains binary data")
    return ALLOWED[ext]


class Scanner(Protocol):
    def scan(self, data: bytes) -> None: ...


class NullScanner:
    """Placeholder malware scanner. Swap for a ClamAV client before accepting untrusted multi-user uploads."""

    def scan(self, data: bytes) -> None:
        return None


scanner: Scanner = NullScanner()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class LocalVolumeStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError("Invalid storage key")
        return p

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


def get_storage() -> LocalVolumeStorage:
    return LocalVolumeStorage(get_settings().storage_dir)
