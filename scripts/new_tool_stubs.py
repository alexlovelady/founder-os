"""One-off: create planned-tool stub packages under modules/ and register them. Usage: python scripts/new_tool_stubs.py"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = [
    ("compliance", "Compliance Center", "Deadlines, filings, licenses and recurring obligations, from rules matched to your business.", "business"),
    ("health", "Business Health", "What you may be forgetting, by area: legal, compliance, finance, operations, sales, security.", "business"),
    ("tasks", "Tasks & reminders", "One task list for everything: yours, and the ones other tools raise.", "operations"),
    ("vault", "Document Vault", "Every business file in one place: upload, organize, search, track expirations.", "legal"),
    ("sops", "SOPs & business documents", "Write your processes and everyday business documents: SOPs, proposals, policies, checklists.", "operations"),
    ("crm", "CRM", "Leads, customers, pipeline and notes.", "growth"),
    ("marketing", "Marketing", "Brand voice, social posts, emails, and ad copy drafted for your business.", "growth"),
    ("founderai", "Ask FounderOS", "An assistant that knows your business and every tool, and can act on them.", "business"),
    ("product", "Product Scan", "Link a git repository so FounderOS understands what you have built.", "business"),
    ("competitors", "Competitor Research", "Who else is out there, what they offer, and where you can stand out.", "growth"),
]

ws = json.loads((ROOT / "package.json").read_text())
registry_imports, registry_list = [], ["finance"]
for tid, name, desc, group in TOOLS:
    d = ROOT / "modules" / tid
    (d / "src").mkdir(parents=True, exist_ok=True)
    (d / "test").mkdir(exist_ok=True)
    pkg = {"name": f"@founderos/{tid}", "version": "0.1.0", "private": True, "main": "src/index.tsx", "types": "src/index.tsx",
           "dependencies": {"@founderos/sdk": "*", "zod": "^4.0.0"}, "peerDependencies": {"react": "^19"},
           "devDependencies": {"@types/react": "^19", "typescript": "^5"}}
    (d / "package.json").write_text(json.dumps(pkg, indent=2) + "\n")
    idx = d / "src" / "index.tsx"
    if not idx.exists():
        idx.write_text(
            'import type { ToolDef } from "@founderos/sdk";\n\n'
            f'export const tool: ToolDef = {{\n  id: "{tid}",\n  name: {json.dumps(name)},\n  description: {json.dumps(desc)},\n'
            f'  group: "{group}",\n  status: "planned",\n}};\n')
    entry = f"modules/{tid}"
    if entry not in ws["workspaces"]:
        ws["workspaces"].append(entry)
    registry_imports.append(f'import {{ tool as {tid} }} from "@founderos/{tid}";')
    registry_list.append(tid)
(ROOT / "package.json").write_text(json.dumps(ws, indent=2) + "\n")
reg = ROOT / "shell/src/lib/tools/registry.ts"
reg.write_text(
    'import type { ToolDef } from "@founderos/sdk";\nimport { tool as finance } from "@founderos/finance";\n' + "\n".join(registry_imports) +
    "\n\n/** Every tool in the product. Adding a tool = a folder under /modules, a workspace entry, and one line here. */\n"
    f"export const TOOLS: ToolDef[] = [{', '.join(registry_list)}];\n\nexport const getTool = (id: string) => TOOLS.find((t) => t.id === id);\n")
print("ok", len(TOOLS))
