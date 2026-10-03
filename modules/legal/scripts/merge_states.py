#!/usr/bin/env python
"""Merge the per-batch verified state source files into api/legalai/corpus/states.json (what the app reads)."""
import glob
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "api/legalai/corpus"
CAVEAT_WORDS = re.compile(r"session law|bill|engrossed|compilation|per-section|partial|unofficial|not current|later amendments|mirror", re.I)

BUILTIN = [  # already verified earlier in the project
    {"state": "Delaware", "code": "DE", "kind": "llc", "title": "Delaware Limited Liability Company Act", "citation": "6 Del. C. ch. 18",
     "items": [{"name": t, "url": f"https://delcode.delaware.gov/title6/c018/sc{n}/index.html"} for n, t in (
         ("01", "Subchapter I General Provisions"), ("02", "Subchapter II Formation"), ("03", "Subchapter III Members"), ("04", "Subchapter IV Managers"),
         ("05", "Subchapter V Finance"), ("06", "Subchapter VI Distributions and Resignation"), ("07", "Subchapter VII Assignment"), ("08", "Subchapter VIII Dissolution"))],
     "notes": "Official Delaware Code online, one page per subchapter."},
    {"state": "Delaware", "code": "DE", "kind": "corp", "title": "Delaware General Corporation Law", "citation": "8 Del. C. ch. 1",
     "items": [{"name": t, "url": f"https://delcode.delaware.gov/title8/c001/sc{n}/index.html"} for n, t in (
         ("01", "Subchapter I Formation"), ("02", "Subchapter II Powers"), ("04", "Subchapter IV Directors and Officers"), ("05", "Subchapter V Stock and Dividends"),
         ("06", "Subchapter VI Stock Transfers"), ("07", "Subchapter VII Meetings, Elections, Voting"), ("08", "Subchapter VIII Amendments and Capital"),
         ("09", "Subchapter IX Merger, Consolidation, Conversion"), ("10", "Subchapter X Sale of Assets, Dissolution"), ("14", "Subchapter XIV Close Corporations"))],
     "notes": "Official Delaware Code online, one page per subchapter."},
    {"state": "North Carolina", "code": "NC", "kind": "llc", "title": "North Carolina Limited Liability Company Act", "citation": "N.C. Gen. Stat. ch. 57D",
     "items": [{"name": "Chapter 57D", "url": "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter/Chapter_57D.html", "text_chars": 160285}], "notes": ""},
    {"state": "North Carolina", "code": "NC", "kind": "corp", "title": "North Carolina Business Corporation Act", "citation": "N.C. Gen. Stat. ch. 55",
     "items": [{"name": "Chapter 55", "url": "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter/Chapter_55.html"}], "notes": ""},
]
LABEL = {"llc": "LLC Act", "corp": "Corporation Act", "securities": "Securities Act"}


def main() -> int:
    entries = list(BUILTIN)
    for f in sorted(glob.glob(str(ROOT / "states" / "batch*.json"))):
        entries += json.load(open(f, encoding="utf8"))
    states: dict[str, dict] = {}
    for e in entries:
        s = states.setdefault(e["code"], {"name": e["state"], "code": e["code"], "kinds": {}})
        notes = " ".join(x for x in (e.get("notes", ""), e.get("reason", "")) if x).strip()
        s["kinds"][e["kind"]] = {"title": e["title"], "citation": e.get("citation", ""), "items": e["items"], "notes": notes,
                                 "caveat": bool(e["items"] and CAVEAT_WORDS.search(notes)), "label": LABEL.get(e["kind"], e["kind"])}
    for s in states.values():  # a kind that points at the same URLs as another kind is loaded once
        seen: set[str] = set()
        for kind in ("llc", "corp", "securities"):
            k = s["kinds"].get(kind)
            if not k:
                continue
            urls = {i["url"] for i in k["items"]}
            k["duplicate_of_other_kind"] = bool(urls and urls <= seen)
            seen |= urls
    out = {"generated": str(date.today()), "states": dict(sorted(states.items()))}
    (ROOT / "states.json").write_text(json.dumps(out, indent=1), encoding="utf8")
    full = sum(1 for s in states.values() if any(k["items"] for k in s["kinds"].values()))
    print(f"{len(states)} jurisdictions, {full} with at least one verified source")
    missing = [(c, k) for c, s in states.items() for k, v in s["kinds"].items() if not v["items"] and k != "securities"]
    print("missing llc/corp:", sorted(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
