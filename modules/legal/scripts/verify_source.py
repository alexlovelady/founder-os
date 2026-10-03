#!/usr/bin/env python
"""Check that an official source URL can be loaded into the authority library.

  python scripts/verify_source.py <url> [--expect "limited liability company"] [--expect "member"]

Fetches the URL the same way the library does (https only, public hosts, size cap, redirects checked), honours robots.txt,
parses it with the real parsers/chunker, and prints one JSON object: status, content type, bytes, extracted characters,
chunk count, whether each expected phrase appears, and a short sample. Exit code 0 only if the page loads, is allowed by
robots.txt, yields a reasonable amount of text, and contains every expected phrase."""
import argparse
import asyncio
import json
import sys
import urllib.robotparser
from urllib.parse import urlparse

from legalai.corpus.adapters import UrlAdapter
from legalai.corpus.safe_fetch import FetchBlocked, safe_get
from legalai.ingestion.chunking import chunk_document
from legalai.ingestion.parsers import NeedsOcr, ParseError, parse_document


async def robots_ok(url: str) -> bool:
    u = urlparse(url)
    try:
        r = await safe_get(f"{u.scheme}://{u.netloc}/robots.txt", timeout=15)
    except FetchBlocked:
        return True
    if r.status != 200:
        return True  # no robots.txt means no restrictions
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(r.content.decode("utf-8", "replace").splitlines())
    return rp.can_fetch("LegalAI-corpus", url)


async def check(url: str, expect: list[str]) -> dict:
    out: dict = {"url": url, "ok": False}
    try:
        out["robots_allowed"] = await robots_ok(url)
        r = await safe_get(url, timeout=60)
    except FetchBlocked as e:
        out["error"] = str(e)
        return out
    out["status"], out["content_type"], out["bytes"] = r.status, r.headers.get("content-type", ""), len(r.content)
    out["final_url"] = r.url
    if r.status != 200:
        out["error"] = f"HTTP {r.status}"
        return out
    ext = "pdf" if "pdf" in out["content_type"].lower() or r.content[:5] == b"%PDF-" else "html"
    try:
        doc = parse_document(f"source.{ext}", r.content)
    except (ParseError, NeedsOcr) as e:
        out["error"] = f"parse: {e}"
        return out
    low = doc.text.lower()
    out["text_chars"], out["chunks"] = len(doc.text), len(chunk_document(doc))
    out["expect"] = {e: (e.lower() in low) for e in expect}
    out["sample"] = doc.text[:240].replace("\n", " ")
    out["ok"] = bool(out["robots_allowed"] and out["text_chars"] > 3000 and all(out["expect"].values()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--expect", action="append", default=[])
    a = ap.parse_args()
    res = asyncio.run(check(a.url, a.expect))
    print(json.dumps(res, indent=2))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
