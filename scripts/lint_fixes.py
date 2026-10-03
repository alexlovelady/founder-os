"""One-off lint fixes after the parallel tool build."""
from pathlib import Path

R = Path(__file__).resolve().parents[1] / "modules"


def edit(rel, pairs):
    p = R / rel
    s = p.read_text(encoding="utf8")
    for a, b in pairs:
        assert a in s, (rel, a)
        s = s.replace(a, b, 1)
    p.write_text(s, encoding="utf8")


edit("founderai/src/rag.ts", [
    ("  let attention = input.attention.slice(0, 6);", "  const attention = input.attention.slice(0, 6);"),
    ("  let toolPages = input.toolPages.slice(0, 12);", "  const toolPages = input.toolPages.slice(0, 12);"),
])
edit("founderai/src/ui/Chat.tsx", [
    ("  useEffect(() => { if (initialId) void open(initialId); }, [initialId, open]);",
     "  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the first conversation once on mount\n  useEffect(() => { if (initialId) void open(initialId); }, [initialId, open]);"),
])
edit("crm/src/ui/CrmApp.tsx", [
    ("interface Res { ok: boolean; status: number; data: any }",
     "// eslint-disable-next-line @typescript-eslint/no-explicit-any -- API payloads are untyped JSON\ninterface Res { ok: boolean; status: number; data: any }"),
])
edit("sdk/src/testing.ts", [
    ("export async function call(", "// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary JSON" + chr(10) + "export async function call("),
])
