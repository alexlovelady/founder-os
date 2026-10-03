# FounderOS

AI back-office for founders, freelancers and small businesses. One SaaS shell, with each tool as its own module in its own
folder so any of them can be changed, tested and deployed on its own.

```
shell/                  FounderOS web app (Next.js): sign-in, business profile, dashboard, billing, embeds the modules
modules/
  legal/                LegalAI: contract review, drafting, cited research, legal library (FastAPI + Postgres + React)
  (future)              compliance, finance, sops, crm ... each gets its own folder with the same contract
services/
  gpu-gateway/          Shared private-GPU agent: runs models on the owner's PC for any module
infra/                  Deployment config shared by modules
docs/                   Platform docs: architecture, roadmap, build spec
```

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md). The product spec is
[docs/FounderOS_Build_Spec.md](docs/FounderOS_Build_Spec.md). LegalAI's own README is [modules/legal/README.md](modules/legal/README.md).

Not legal, tax or financial advice. FounderOS is software, not a law firm or accounting firm.
