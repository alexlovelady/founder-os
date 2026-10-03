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
            title = int(cfg["title"])
            part = int(cfg["part"]) if cfg.get("part") not in (None, "") else None
        except (KeyError, TypeError, ValueError):
            raise SourceError("ecfr needs an integer title and a part or a list of sections")
        secs = [s.strip() for s in str(cfg.get("sections", "")).split(",") if s.strip()]
        if not (1 <= title <= 50) or (part is None and not secs) or (part is not None and not 1 <= part <= 9999):
            raise SourceError("ecfr needs a title (1-50) and either a part or a list of sections like 230.501, 230.502")
        if any(not re.fullmatch(r"\d+\.[\w.-]+", s) for s in secs) or len(secs) > 40:
            raise SourceError("Sections must look like 230.506 (at most 40)")
        out = {"title": title}
        if part is not None:
            out["part"] = part
        if secs:
            out["sections"] = ", ".join(secs)
        return out
    if adapter == "uscode":
        try:
            title = int(cfg["title"])
        except (KeyError, TypeError, ValueError):
            raise SourceError("uscode needs an integer title")
        if not 1 <= title <= 54:
            raise SourceError("title out of range")
        parse_sections(cfg.get("sections", ""))
        return {"title": title, "sections": str(cfg["sections"])[:300], **({"title_text": str(cfg["title_text"])[:200]} if cfg.get("title_text") else {})}
    if adapter == "courtlistener":
        try:
            return {"opinion_id": int(cfg["opinion_id"])}
        except (KeyError, TypeError, ValueError):
            raise SourceError("courtlistener needs an integer opinion_id")
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
        title = int(cfg["title"])
        part = int(cfg["part"]) if cfg.get("part") else None
        secs = [s.strip() for s in str(cfg.get("sections", "")).split(",") if s.strip()]
        meta = await self.fetch(f"{ECFR}/titles.json")
        if meta.status != 200:
            raise SourceError(f"eCFR titles endpoint returned HTTP {meta.status}")
        import json
        entry = next((t for t in json.loads(meta.content)["titles"] if t["number"] == title), None)
        if not entry:
            raise SourceError(f"eCFR title {title} not found")
        as_of = entry.get("up_to_date_as_of") or entry.get("latest_issue_date")
        key = f"{title}:{part or ''}:{','.join(secs)}:{as_of}"
        if etag and etag == key:
            return FetchResult(unchanged=True, etag=etag)
        if secs:
            pieces = []
            for sec in secs:
                r = await self.fetch(f"{ECFR}/full/{as_of}/title-{title}.xml?section={sec}")
                if r.status != 200:
                    raise SourceError(f"eCFR returned HTTP {r.status} for {title} CFR {sec}")
                t = _ecfr_text(r.content)
                if len(t) >= 40:
                    pieces.append(t)
            text = "\n\n".join(pieces)
            label = f"{title} CFR \u00a7\u00a7 {', '.join(secs)}"
            cite = f"{title} C.F.R. \u00a7\u00a7 {', '.join(secs)}"
            url = f"https://www.ecfr.gov/current/title-{title}"
        else:
            r = await self.fetch(f"{ECFR}/full/{as_of}/title-{title}.xml?part={part}")
            if r.status != 200:
                raise SourceError(f"eCFR returned HTTP {r.status} for title {title} part {part}")
            text = _ecfr_text(r.content)
            label, cite = f"{title} CFR Part {part}", f"{title} C.F.R. pt. {part}"
            url = f"https://www.ecfr.gov/current/title-{title}/part-{part}"
        if len(text) < 100:
            raise SourceError("eCFR returned no text for that selection")
        return FetchResult(content=text.encode(), filename=f"{title}-cfr-{part or 'sections'}.txt", title=cfg.get("title_text") or label,
                           citation=cite, effective_from=date.fromisoformat(as_of), source_url=url, etag=key,
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


def parse_sections(spec: str) -> list[str]:
    """'101-122, 201, 203-205' -> ['101', ..., '122', '201', '203', ...]. Capped to keep one source reasonable."""
    out: list[str] = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if b < a or b - a > 150:
                raise SourceError("Section ranges must be ascending and at most 150 sections")
            out += [str(n) for n in range(a, b + 1)]
        elif re.fullmatch(r"\d+[A-Za-z0-9-]*", part):
            out.append(part)
        else:
            raise SourceError(f"Bad section '{part}'")
    if not out or len(out) > 200:
        raise SourceError("Give between 1 and 200 sections")
    return out


class UscodeAdapter:
    """U.S. Code sections from the GPO govinfo link service (official, no key). Each section is fetched politely and
    joined into one document so the library holds e.g. '17 U.S.C. 101-122' as a unit with a single version history."""

    LINK = "https://www.govinfo.gov/link/uscode/{title}/{section}?link-type=html&year=mostrecent"

    def __init__(self, fetch=safe_get, delay: float = 0.4):
        self.fetch, self.delay = fetch, delay

    async def run(self, cfg: dict, etag: str | None = None) -> FetchResult:
        import asyncio
        from ..ingestion.parsers import parse_html
        title, sections = int(cfg["title"]), parse_sections(cfg["sections"])
        parts, missing, edition = [], [], None
        for sec in sections:
            r = await self.fetch(self.LINK.format(title=title, section=sec))
            m = re.search(r"/(USCODE-(\d{4})-title\d+)/", r.url)
            if r.status != 200 or not m:
                missing.append(sec)
                continue
            edition = edition or m.group(2)
            text = parse_html(r.content).text
            i = text.find(f"§{sec}.")
            parts.append(text[i:] if i >= 0 else text)
            await asyncio.sleep(self.delay)
        if not parts:
            raise SourceError("No sections could be fetched from govinfo")
        body = "\n\n".join(parts)
        return FetchResult(content=body.encode(), filename=f"usc-{title}-{sections[0]}.txt",
                           title=cfg.get("title_text") or f"{title} U.S.C. §§ {cfg['sections']}",
                           citation=f"{title} U.S.C. §§ {cfg['sections']}" + (f" ({edition} ed.)" if edition else ""),
                           effective_from=date.today(), source_url=f"https://www.govinfo.gov/app/collection/uscode",
                           etag=None, retrieved_at=datetime.now(timezone.utc))


class CourtListenerAdapter:
    """One court opinion from CourtListener (Free Law Project). Needs a free API token in COURTLISTENER_TOKEN.
    Fetches the opinion text and cluster metadata (case name, date, citations, precedential status). It does NOT derive
    treatment (whether the case was overruled or followed): that must come from an authoritative source via the
    treatment import or the library UI."""

    BASE = "https://www.courtlistener.com/api/rest/v4"

    def __init__(self, fetch=safe_get, token: str | None = None):
        self.fetch, self.token = fetch, token

    async def run(self, cfg: dict, etag: str | None = None) -> FetchResult:
        import os
        from ..ingestion.parsers import parse_html
        token = self.token or os.environ.get("COURTLISTENER_TOKEN", "")
        if not token:
            raise SourceError("COURTLISTENER_TOKEN is not set")
        hdr = {"Authorization": f"Token {token}"}

        async def get_json(url):
            r = await self.fetch(url, hdr)
            if r.status != 200:
                raise SourceError(f"CourtListener returned HTTP {r.status}")
            import json
            return json.loads(r.content)

        op = await get_json(f"{self.BASE}/opinions/{int(cfg['opinion_id'])}/")
        text = op.get("plain_text") or ""
        if not text.strip():
            html = op.get("html_with_citations") or op.get("html") or op.get("html_lawbox") or ""
            text = parse_html(html.encode()).text if html else ""
        if len(text.strip()) < 200:
            raise SourceError("The opinion has no usable text")
        meta = {}
        if op.get("cluster"):
            meta = await get_json(op["cluster"].replace("http://", "https://"))
        cites = meta.get("citations") or []
        citation = "; ".join(f"{c.get('volume')} {c.get('reporter')} {c.get('page')}" for c in cites if isinstance(c, dict)) or cfg.get("citation", "")
        filed = meta.get("date_filed")
        return FetchResult(content=text.encode(), filename=f"opinion-{cfg['opinion_id']}.txt",
                           title=meta.get("case_name") or f"Opinion {cfg['opinion_id']}", citation=citation,
                           effective_from=date.fromisoformat(filed) if filed else None,
                           source_url=op.get("absolute_url") and f"https://www.courtlistener.com{op['absolute_url']}" or "https://www.courtlistener.com",
                           etag=None, retrieved_at=datetime.now(timezone.utc))


ADAPTERS = {"ecfr": EcfrAdapter, "url": UrlAdapter, "uscode": UscodeAdapter, "courtlistener": CourtListenerAdapter}


def build_adapter(name: str):
    if name not in ADAPTERS:
        raise SourceError(f"Unknown adapter '{name}'")
    return ADAPTERS[name]()
