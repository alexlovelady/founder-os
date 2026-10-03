"""Deterministic redline/compare primitives."""
import difflib
import re
from dataclasses import dataclass

from .checks import classify_topics, key_figures

TOKEN = re.compile(r"\s+|[^\s]+")


def word_diff(a: str, b: str) -> list[dict]:
    """[{op: equal|insert|delete, text}] at word level, whitespace preserved. Joining equal+delete text gives `a`;
    equal+insert gives `b` (tested)."""
    ta, tb = TOKEN.findall(a), TOKEN.findall(b)
    out: list[dict] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ta, tb, autojunk=False).get_opcodes():
        if tag == "equal":
            out.append({"op": "equal", "text": "".join(ta[i1:i2])})
        else:
            if i2 > i1:
                out.append({"op": "delete", "text": "".join(ta[i1:i2])})
            if j2 > j1:
                out.append({"op": "insert", "text": "".join(tb[j1:j2])})
    return out


def apply_ops(ops: list[dict], side: str) -> str:
    keep = ("equal", "delete") if side == "a" else ("equal", "insert")
    return "".join(o["text"] for o in ops if o["op"] in keep)


def _ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def _label(c: dict) -> str:
    return " > ".join(c.get("heading_path") or []) or c.get("section") or ""


@dataclass
class ClauseRef:
    chunk_id: str
    text: str
    section: str = ""
    heading_path: tuple = ()
    page: int | None = None


def compare_clauses(a: list[dict], b: list[dict], threshold: float = 0.55) -> dict:
    """Align clauses of two versions (same numbered section first, then best text similarity) and classify changes."""
    used_a: set[int] = set()
    pairs: list[tuple[int | None, int | None, float]] = []
    by_section = {}
    for i, ca in enumerate(a):
        if ca.get("section"):
            by_section.setdefault(ca["section"], []).append(i)
    for j, cb in enumerate(b):
        best, best_r = None, 0.0
        cand = [i for i in by_section.get(cb.get("section") or "", []) if i not in used_a] or \
               [i for i in range(len(a)) if i not in used_a]
        for i in cand:
            r = _ratio(a[i]["text"], cb["text"])
            if r > best_r:
                best, best_r = i, r
        if best is not None and best_r >= threshold:
            used_a.add(best)
            pairs.append((best, j, best_r))
        else:
            pairs.append((None, j, 0.0))
    for i in range(len(a)):
        if i not in used_a:
            pairs.append((i, None, 0.0))
    changes, counts = [], {"added": 0, "removed": 0, "modified": 0, "unchanged": 0}
    for i, j, r in sorted(pairs, key=lambda p: (p[1] if p[1] is not None else 10**6, p[0] or 0)):
        if i is not None and j is not None:
            if a[i]["text"] == b[j]["text"]:
                counts["unchanged"] += 1
                continue
            ops = word_diff(a[i]["text"], b[j]["text"])
            fa, fb = key_figures(a[i]["text"]), key_figures(b[j]["text"])
            fig = {k: {"removed": sorted(set(getattr(fa, k)) - set(getattr(fb, k))), "added": sorted(set(getattr(fb, k)) - set(getattr(fa, k)))}
                   for k in ("money", "durations", "percents")}
            fig = {k: v for k, v in fig.items() if v["removed"] or v["added"]}
            counts["modified"] += 1
            changes.append({"type": "modified", "label": _label(b[j]), "similarity": round(r, 3), "a": a[i], "b": b[j], "ops": ops,
                            "figure_changes": fig, "topics": classify_topics(a[i]["text"] + " " + b[j]["text"])})
        elif j is not None:
            counts["added"] += 1
            changes.append({"type": "added", "label": _label(b[j]), "b": b[j], "topics": classify_topics(b[j]["text"])})
        else:
            counts["removed"] += 1
            changes.append({"type": "removed", "label": _label(a[i]), "a": a[i], "topics": classify_topics(a[i]["text"])})
    by_topic: dict[str, dict] = {}
    for c in changes:
        for t in c["topics"] or ["other"]:
            by_topic.setdefault(t, {"added": 0, "removed": 0, "modified": 0})[c["type"]] += 1
    return {"counts": counts, "changes": changes, "by_topic": by_topic}
