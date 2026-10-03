"""OCR fallback (spec job type OCR_fallback). Tesseract via pytesseract; PDF pages are rasterized with PyMuPDF.
OCR text is stored with ocr_applied=True so every consumer knows quotes were verified against recognized text,
which can contain recognition errors."""
import io
import os
import shutil
from dataclasses import dataclass

from ..config import Settings
from .parsers import Block, NeedsOcr, ParseError, ParsedDoc, _split_paragraphs

WINDOWS_DEFAULT = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


@dataclass
class OcrResult:
    doc: ParsedDoc
    confidence: float  # mean word confidence 0-100


def tesseract_cmd(settings: Settings) -> str | None:
    for c in (settings.tesseract_cmd, shutil.which("tesseract"), WINDOWS_DEFAULT):
        if not c:
            continue
        if not os.path.isabs(c) or os.path.exists(c):
            return c
    return None


def ocr_available(settings: Settings) -> bool:
    return bool(settings.ocr_enabled and tesseract_cmd(settings))


def _page_text(img, settings: Settings) -> tuple[str, list[float]]:
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = tesseract_cmd(settings)
    data = pytesseract.image_to_data(img, lang=settings.ocr_lang, output_type=pytesseract.Output.DICT)
    lines: dict[tuple, list[str]] = {}
    confs: list[float] = []
    for i, w in enumerate(data["text"]):
        if not str(w).strip():
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(w)
        c = float(data["conf"][i])
        if c >= 0:
            confs.append(c)
    # paragraphs = (block, paragraph) groups; lines within one paragraph are joined
    paras: dict[tuple, list[str]] = {}
    for (b, p, _l), words in lines.items():
        paras.setdefault((b, p), []).append(" ".join(words))
    return "\n\n".join(" ".join(v) for v in paras.values()), confs


def ocr_pdf(data: bytes, settings: Settings) -> OcrResult:
    import pymupdf
    from PIL import Image
    try:
        pdf = pymupdf.open(stream=data, filetype="pdf")
    except Exception as e:  # noqa: BLE001
        raise ParseError(f"Unreadable PDF: {e}") from e
    blocks: list[Block] = []
    confs: list[float] = []
    n = min(len(pdf), settings.ocr_max_pages)
    for i in range(n):
        pix = pdf[i].get_pixmap(dpi=settings.ocr_dpi)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        text, c = _page_text(img, settings)
        confs += c
        blocks += _split_paragraphs(text, i + 1)
    doc = ParsedDoc(blocks, len(pdf)).finalize()
    if not doc.text.strip():
        raise NeedsOcr("OCR found no readable text")
    return OcrResult(doc, sum(confs) / len(confs) if confs else 0.0)


def ocr_image(data: bytes, settings: Settings) -> OcrResult:
    from PIL import Image, UnidentifiedImageError
    try:
        img = Image.open(io.BytesIO(data))
        frames = []
        for i in range(getattr(img, "n_frames", 1)):  # multi-page TIFF
            img.seek(i)
            frames.append(img.convert("RGB"))
    except (UnidentifiedImageError, OSError) as e:
        raise ParseError(f"Unreadable image: {e}") from e
    blocks: list[Block] = []
    confs: list[float] = []
    for i, f in enumerate(frames[:settings.ocr_max_pages], start=1):
        text, c = _page_text(f, settings)
        confs += c
        blocks += _split_paragraphs(text, i)
    doc = ParsedDoc(blocks, len(frames)).finalize()
    if not doc.text.strip():
        raise NeedsOcr("OCR found no readable text")
    return OcrResult(doc, sum(confs) / len(confs) if confs else 0.0)


def ocr_document(filename: str, data: bytes, settings: Settings) -> OcrResult:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ocr_pdf(data, settings) if ext == "pdf" else ocr_image(data, settings)
