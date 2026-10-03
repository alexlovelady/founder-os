#!/usr/bin/env python
"""Resolve landmark cases to CourtListener opinion IDs and verify each loads (needs COURTLISTENER_TOKEN).
Writes api/legalai/corpus/cases.json. Only cases whose citation matches and whose text loads are kept."""
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx

from legalai.corpus.adapters import CourtListenerAdapter, SourceError

OUT = Path(__file__).resolve().parents[1] / "api/legalai/corpus/cases.json"

CASES = [
    # (group, short name, search citation, must-appear word in the case name)
    ("Delaware corporate duties", "Smith v. Van Gorkom (duty of care in a sale)", "488 A.2d 858", "gorkom"),
    ("Delaware corporate duties", "Revlon v. MacAndrews & Forbes (duties in a sale of control)", "506 A.2d 173", "revlon"),
    ("Delaware corporate duties", "Unocal v. Mesa Petroleum (defensive measures)", "493 A.2d 946", "unocal"),
    ("Delaware corporate duties", "Weinberger v. UOP (entire fairness)", "457 A.2d 701", "weinberger"),
    ("Delaware corporate duties", "Guth v. Loft (corporate opportunity)", "5 A.2d 503", "guth"),
    ("Delaware corporate duties", "Aronson v. Lewis (business judgment rule)", "473 A.2d 805", "aronson"),
    ("Delaware corporate duties", "In re Caremark (oversight duty)", "698 A.2d 959", "caremark"),
    ("Delaware corporate duties", "Stone v. Ritter (oversight duty)", "911 A.2d 362", "ritter"),
    ("Delaware corporate duties", "Schnell v. Chris-Craft (inequitable conduct)", "285 A.2d 437", "chris-craft"),
    ("Delaware corporate duties", "Blasius v. Atlas (stockholder franchise)", "564 A.2d 651", "blasius"),
    ("Delaware corporate duties", "Corwin v. KKR Financial (stockholder approval)", "125 A.3d 304", "kkr"),
    ("Delaware corporate duties", "Brophy v. Cities Service (insider trading duty)", "70 A.2d 5", "cities service"),
    ("Delaware corporate duties", "Marchand v. Barnhill (board oversight)", "212 A.3d 805", "barnhill"),
    ("Delaware startups and venture financings", "In re Trados (preferred vs common stockholders)", "73 A.3d 17", "trados"),
    ("Delaware startups and venture financings", "Carsanaro v. Bloodhound Technologies (startup financing)", "65 A.3d 618", "bloodhound"),
    ("Delaware startups and venture financings", "Klaassen v. Allegro Development (CEO termination, board duties)", "106 A.3d 1035", "allegro"),
    ("Delaware startups and venture financings", "Omnicare v. NCS Healthcare (deal protection)", "818 A.2d 914", "omnicare"),
    ("Delaware LLC law", "Elf Atochem v. Jaffari (LLC contract freedom)", "727 A.2d 286", "jaffari"),
    ("Delaware LLC law", "Gatz Properties v. Auriga Capital (LLC fiduciary duties)", "59 A.3d 1206", "auriga"),
    ("Delaware LLC law", "Dieckman v. Regency (implied covenant in LLC agreements)", "155 A.3d 358", "regency"),
    ("Securities law basics for fundraising", "SEC v. W.J. Howey (what is an investment contract)", "328 U.S. 293", "howey"),
    ("Securities law basics for fundraising", "Reves v. Ernst & Young (when is a note a security)", "494 U.S. 56", "reves"),
    ("Securities law basics for fundraising", "Basic v. Levinson (materiality)", "485 U.S. 224", "levinson"),
    ("Securities law basics for fundraising", "TSC Industries v. Northway (materiality standard)", "426 U.S. 438", "northway"),
]


async def main() -> int:
    tok = os.environ.get("COURTLISTENER_TOKEN")
    if not tok:
        print("COURTLISTENER_TOKEN required", file=sys.stderr)
        return 2
    hdr = {"Authorization": f"Token {tok}"}
    out = json.loads(OUT.read_text()) if OUT.exists() else []     # keep what is already verified; only resolve the rest
    done = {c["name"] for c in out}
    bad = []
    async with httpx.AsyncClient(timeout=30, headers=hdr) as c:
        for group, name, cite, word in CASES:
            if name in done:
                continue
            await asyncio.sleep(4)
            r = await c.get("https://www.courtlistener.com/api/rest/v4/search/", params={"q": f'citation:("{cite}")', "type": "o"})
            for wait in (10, 30, 60):
                if r.status_code != 429:
                    break
                await asyncio.sleep(wait)
                r = await c.get("https://www.courtlistener.com/api/rest/v4/search/", params={"q": f'citation:("{cite}")', "type": "o"})
            if r.status_code != 200:
                bad.append((name, f"search HTTP {r.status_code}"))
                continue
            hit = next((x for x in r.json().get("results", []) if word in (x.get("caseName") or "").lower()
                        and any(cite in cc for cc in (x.get("citation") or []))), None)
            if not hit:
                bad.append((name, "no matching result"))
                continue
            ops = [o["id"] for o in hit.get("opinions", [])] or [hit["cluster_id"]]
            loaded = None
            for oid in ops[:4]:
                try:
                    res = await CourtListenerAdapter(token=tok).run({"opinion_id": oid})
                except SourceError:
                    continue
                if len(res.content) > 3000:
                    loaded = (oid, res)
                    break
            if not loaded:
                bad.append((name, "no opinion text"))
                continue
            oid, res = loaded
            out.append({"group": group, "name": name, "opinion_id": oid, "case_name": res.title, "citation": res.citation,
                        "decided": str(res.effective_from), "chars": len(res.content)})
            print("ok ", name, oid, len(res.content))
            OUT.write_text(json.dumps(out, indent=1))   # incremental: a stall keeps what is verified so far
            await asyncio.sleep(3)
    Path(__file__).resolve().parents[1].joinpath("api/legalai/corpus/cases.json").write_text(json.dumps(out, indent=1))
    print(f"{len(out)} verified, {len(bad)} failed:", *bad, sep="\n  ")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
