"""Source adapters (spec section 28): each fetches from an OFFICIAL source and records URL, retrieval time,
jurisdiction, authority type, effective date and a content hash. Adapters know nothing about reasoning."""
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone

from defusedxml import ElementTree as ET

from .safe_fetch import FetchBlocked, safe_get

ECFR = "https://www.ecfr.gov/api/versioner/v1"


class SourceError(Exception):
    pass


@dataclass
class FetchResult:
    unchanged: bool = False
    content: bytes = b""
    filename: str = ""
    title: str = ""
    citation: str = ""
    effective_from: date | None = None
    source_url: str = ""
    etag: str | None = None
    retrieved_at: datetime | None = None


def validate_config(adapter: str, cfg: dict) -> dict:
    if adapter == "ecfr":
        try:
            title, part = int(cfg["title"]), int(cfg["part"])
        except (KeyError, TypeError, ValueError):
            raise SourceError("ecfr needs integer title and part")
        if not (1 <= title <= 50 and 1 <= part <= 9999):
            raise SourceError("title/part out of range")
        return {"title": title, "part": part}
    if adapter == "url":
        url = str(cfg.get("url", ""))
        if not url.startswith("https://"):
            raise SourceError("url sources must be https")
        out = {"url": url}
        for k in ("title", "citation", "effective_date"):
            if cfg.get(k):
                out[k] = str(cfg[k])[:300]
        return out
    raise SourceError(f"Unknown adapter '{adapter}'")


def _ecfr_text(xml: bytes) -> str:
    root = ET.fromstring(xml)
    lines: list[str] = []

    def txt(el) -> str:
        return re.sub(r"\s+", " ", "".join(el.itertext())).strip()

    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag in ("DIV5", "DIV6", "DIV7", "SUBPART", "SUBJGRP"):
            h = el.find("HEAD")
            if h is not None:
                lines.append(txt(h).upper() if tag in ("DIV5", "SUBPART") else txt(h))
        elif tag == "DIV8":
            h = el.find("HEAD")
            lines.append(txt(h) if h is not None else el.get("N", ""))
        elif tag in ("P", "FP", "EXTRACT") and el.find("P") is None:
            t = txt(el)
            if t:
                lines.append(t)
    return "\n\n".join(l for l in lines if l)


class EcfrAdapter:
    """Code of Federal Regulations via the official eCFR versioner API (no key needed)."""

    def __init__(self, fetch=safe_get):
        self.fetch = fetch

    async def run(self, cfg: dict, etag: str | None = None) -> FetchResult:
        title, part = int(cfg["title"]), int(cfg["part"])
        meta = await self.fetch(f"{ECFR}/titles.json")
        if meta.status != 200:
            raise SourceError(f"eCFR titles endpoint returned HTTP {meta.status}")
        import json
        entry = next((t for t in json.loads(meta.content)["titles"] if t["number"] == title), None)
        if not entry:
            raise SourceError(f"eCFR title {title} not found")
        as_of = entry.get("up_to_date_as_of") or entry.get("latest_issue_date")
        if etag and etag == f"{title}:{part}:{as_of}":
            return FetchResult(unchanged=True, etag=etag)
        r = await self.fetch(f"{ECFR}/full/{as_of}/title-{title}.xml?part={part}")
        if r.status != 200:
            raise SourceError(f"eCFR returned HTTP {r.status} for title {title} part {part}")
        text = _ecfr_text(r.content)
        if len(text) < 100:
            raise SourceError("eCFR returned no text for that title/part")
        return FetchResult(content=text.encode(), filename=f"{title}-cfr-part-{part}.txt", title=f"{title} CFR Part {part}",
                           citation=f"{title} C.F.R. pt. {part}", effective_from=date.fromisoformat(as_of),
                           source_url=f"https://www.ecfr.gov/current/title-{title}/part-{part}", etag=f"{title}:{part}:{as_of}",
                           retrieved_at=datetime.now(timezone.utc))


class UrlAdapter:
    """A single official document at an https URL. Uses conditional GET so unchanged sources cost nothing."""

    EXT = {"application/pdf": "pdf", "text/html": "html", "application/xhtml+xml": "html", "text/plain": "txt", "text/markdown": "md"}

    def __init__(self, fetch=safe_get):
        self.fetch = fetch

    async def run(self, cfg: dict, etag: str | None = None) -> FetchResult:
        hdrs = {"If-None-Match": etag} if etag and not etag.startswith("sha:") else {}
        try:
            r = await self.fetch(cfg["url"], hdrs)
        except FetchBlocked as e:
            raise SourceError(str(e)) from e
        if r.status == 304:
            return FetchResult(unchanged=True, etag=etag)
        if r.status != 200:
            raise SourceError(f"Source returned HTTP {r.status}")
        ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
        ext = self.EXT.get(ctype)
        if not ext:
            raise SourceError(f"Unsupported content type '{ctype}'")
        eff = None
        if cfg.get("effective_date"):
            try:
                eff = date.fromisoformat(cfg["effective_date"])
            except ValueError:
                raise SourceError("effective_date must be YYYY-MM-DD")
        return FetchResult(content=r.content, filename=f"source.{ext}", title=cfg.get("title") or cfg["url"],
                           citation=cfg.get("citation", ""), effective_from=eff, source_url=cfg["url"],
                           etag=r.headers.get("etag"), retrieved_at=datetime.now(timezone.utc))


ADAPTERS = {"ecfr": EcfrAdapter, "url": UrlAdapter}


def build_adapter(name: str):
    if name not in ADAPTERS:
        raise SourceError(f"Unknown adapter '{name}'")
    return ADAPTERS[name]()
