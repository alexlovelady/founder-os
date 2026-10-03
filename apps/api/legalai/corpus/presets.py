"""One-click starting points for the shared library. All come from official sources (eCFR API, govinfo). They are
examples of what small businesses and startups commonly need, not a complete or authoritative selection: add what
your matters require. Large parts take a while to embed on the local GPU."""

PRESETS = [
    {"id": "ftc-safeguards", "name": "FTC Safeguards Rule (16 CFR Part 314)", "adapter": "ecfr", "config": {"title": 16, "part": 314}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Customer information security for financial institutions"},
    {"id": "coppa", "name": "COPPA Rule (16 CFR Part 312)", "adapter": "ecfr", "config": {"title": 16, "part": 312}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Children's online privacy"},
    {"id": "ftc-endorsements", "name": "FTC Endorsement Guides (16 CFR Part 255)", "adapter": "ecfr", "config": {"title": 16, "part": 255}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Advertising, testimonials, influencers"},
    {"id": "franchise-rule", "name": "FTC Franchise Rule (16 CFR Part 436)", "adapter": "ecfr", "config": {"title": 16, "part": 436}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Franchise disclosure"},
    {"id": "hipaa", "name": "HIPAA Privacy, Security and Breach Rules (45 CFR Part 164)", "adapter": "ecfr", "config": {"title": 45, "part": 164}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Large; takes a while to embed"},
    {"id": "flsa-exemptions", "name": "FLSA white-collar exemptions (29 CFR Part 541)", "adapter": "ecfr", "config": {"title": 29, "part": 541}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Overtime exemptions"},
    {"id": "fmla", "name": "Family and Medical Leave Act regulations (29 CFR Part 825)", "adapter": "ecfr", "config": {"title": 29, "part": 825}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Employment leave"},
    {"id": "reg-d", "name": "Regulation D offerings (17 CFR Part 230, sections 501-508)", "adapter": "ecfr", "config": {"title": 17, "part": 230}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Whole Part 230 is very large; consider the URL adapter for just Regulation D"},
    {"id": "reg-z", "name": "Truth in Lending, Regulation Z (12 CFR Part 1026)", "adapter": "ecfr", "config": {"title": 12, "part": 1026}, "jurisdiction": "United States (Federal)", "authority_type": "regulation", "note": "Large"},
    {"id": "copyright-act", "name": "Copyright Act core (17 U.S.C. 101-122)", "adapter": "uscode", "config": {"title": 17, "sections": "101-122"}, "jurisdiction": "United States (Federal)", "authority_type": "statute", "note": "Fetches ~22 sections one by one"},
    {"id": "dtsa", "name": "Defend Trade Secrets Act (18 U.S.C. 1831-1839)", "adapter": "uscode", "config": {"title": 18, "sections": "1831-1839"}, "jurisdiction": "United States (Federal)", "authority_type": "statute", "note": "Trade secrets"},
    {"id": "cfaa", "name": "Computer Fraud and Abuse Act (18 U.S.C. 1030)", "adapter": "uscode", "config": {"title": 18, "sections": "1030"}, "jurisdiction": "United States (Federal)", "authority_type": "statute", "note": ""},
    {"id": "flsa-act", "name": "Fair Labor Standards Act core (29 U.S.C. 201-219)", "adapter": "uscode", "config": {"title": 29, "sections": "201-219"}, "jurisdiction": "United States (Federal)", "authority_type": "statute", "note": ""},
    {"id": "ftc-act", "name": "FTC Act (15 U.S.C. 41-58)", "adapter": "uscode", "config": {"title": 15, "sections": "41-58"}, "jurisdiction": "United States (Federal)", "authority_type": "statute", "note": "Unfair or deceptive practices"},
    {"id": "lanham-core", "name": "Lanham Act, registration and infringement (15 U.S.C. 1051-1072, 1114-1127)", "adapter": "uscode", "config": {"title": 15, "sections": "1051-1072,1114-1127"}, "jurisdiction": "United States (Federal)", "authority_type": "statute", "note": "Trademarks"},
]
