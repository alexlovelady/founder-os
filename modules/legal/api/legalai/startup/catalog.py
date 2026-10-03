"""Startup workflow content: the document types the "Create a document" wizard can draft, and the company legal checklist.

All text here is original. Outlines show the conventional clause order so drafts come out in a familiar structure; they are
starting points for a lawyer's review, not legal advice. Fields become the questions the wizard asks; anything left blank
becomes a [●PLACEHOLDER] in the draft rather than an invented value."""

ENTITY_TYPES = [
    {"id": "delaware_c_corp", "label": "Corporation (C-corp), e.g. a Delaware C-corp"},
    {"id": "llc", "label": "LLC"},
    {"id": "s_corp", "label": "S-corp"},
    {"id": "not_yet", "label": "Not formed yet"},
    {"id": "other", "label": "Something else"},
]

F = lambda key, label, help="", kind="text", required=False, placeholder="", options=None, default="": {  # noqa: E731
    "key": key, "label": label, "help": help, "kind": kind, "required": required, "placeholder": placeholder,
    "options": options or [], "default": default}

STATE_NOTE = F("state", "Governing law (state)", "Usually the state where the company is formed.", required=True, placeholder="e.g. Delaware")

DOC_TYPES = [
    {"id": "founders_agreement", "title": "Founders agreement", "agreement_type": "founders_agreement",
     "blurb": "How the founders split ownership, earn it over time, make decisions, and handle someone leaving.",
     "perspective": "neutral",
     "fields": [
         F("company_name", "Company name", required=True), F("founders", "Founders (full names)", "One per line", "textarea", True, "Ann Lee\nBo Chen"),
         F("equity_split", "Ownership split", "Exact percentages or share counts for each founder", "textarea", True, "Ann 55%, Bo 45%"),
         F("vesting", "Vesting", "The common standard is four years with a one-year cliff", default="4 years, 1-year cliff, monthly after"),
         F("roles", "Roles and time commitment", "Titles and whether each founder is full-time", "textarea", False, "Ann: CEO, full-time. Bo: CTO, full-time."),
         F("decisions", "How decisions are made", kind="select", options=["Majority of ownership", "Unanimous for major decisions, majority otherwise", "Each founder has one vote"], default="Unanimous for major decisions, majority otherwise"),
         F("departure", "If a founder leaves", "What happens to their shares", "textarea", False, "Company may repurchase unvested shares at cost; vested shares stay with the founder."),
         F("entity", "Entity type", kind="select", options=["Corporation", "LLC", "Not formed yet"], default="Corporation"), STATE_NOTE],
     "outline": ["Parties and purpose", "Ownership of the company", "Vesting and repurchase of unvested shares", "Roles, duties and time commitment",
                 "Decision making and deadlock", "Assignment of intellectual property to the company", "Confidentiality", "A founder leaving: buyout and repurchase",
                 "Non-solicitation (note: enforceability varies by state)", "Dispute resolution and governing law", "General provisions"],
     "guidance": "Plain, balanced language. Spell out exact ownership numbers and the vesting schedule. Include a present-tense assignment of all company-related IP by each founder. Provide a way to break a deadlock."},
    {"id": "operating_agreement", "title": "LLC operating agreement", "agreement_type": "operating_agreement",
     "blurb": "The rules for an LLC: who owns what, who manages, how profit is shared, and how members exit.",
     "perspective": "neutral",
     "fields": [
         F("company_name", "LLC name", required=True), STATE_NOTE,
         F("members", "Members, contributions and ownership", "One per line: name, what they contribute, percentage", "textarea", True, "Ann Lee, $20,000 cash, 60%\nBo Chen, software and $10,000, 40%"),
         F("management", "Management", kind="select", options=["Member-managed (all members manage)", "Manager-managed (named managers manage)"], default="Member-managed (all members manage)"),
         F("managers", "Managers (if manager-managed)", "Names", "text", False),
         F("major_decisions", "Decisions that need member approval", "e.g. selling the company, new members, borrowing over a limit", "textarea", False, "Sale of the company; admitting members; debt over $25,000; changing this agreement."),
         F("distributions", "Distributions", "How profits are paid out", default="Pro rata to ownership, with tax distributions each year"),
         F("transfers", "Transfers of ownership", default="Members must offer their interest to the others first (right of first refusal)"),
         F("buy_sell", "Buy-sell triggers", "Events that let the others buy someone out", default="Death, disability, divorce, departure, bankruptcy"),
         F("tax", "Tax treatment", kind="select", options=["Partnership (default for multi-member LLCs)", "S-corp election", "Not sure"], default="Partnership (default for multi-member LLCs)")],
     "outline": ["Formation, name and purpose", "Members, capital contributions and ownership", "Management and voting (including major decisions)", "Allocations and distributions (including tax distributions)",
                 "Books, records and tax matters (partnership representative)", "Transfers and right of first refusal", "Buy-sell and exit events", "Duties and indemnification of managers and members",
                 "Dissolution and winding up", "Dispute resolution and governing law", "General provisions"],
     "guidance": "Make the management structure explicit. Include tax distributions so members can pay tax on allocated income. Provide a valuation method for buyouts."},
    {"id": "nda_mutual", "title": "Mutual NDA", "agreement_type": "nda",
     "blurb": "A two-way confidentiality agreement for talking to partners, vendors or investors.",
     "perspective": "neutral",
     "fields": [F("party_a", "Your company", required=True), F("party_b", "Other party", required=True),
                F("purpose", "Purpose of sharing information", required=True, placeholder="Exploring a possible partnership"),
                F("term_years", "How long the agreement lasts (years)", kind="number", default="2"), F("survival_years", "How long secrets stay protected after it ends (years)", kind="number", default="3"), STATE_NOTE],
     "outline": ["Purpose", "What counts as confidential information", "Obligations of the receiving party", "Exclusions (public, already known, independently developed, received from others)",
                 "Required disclosures", "Term and survival", "Return or destruction of materials", "No license or other rights", "Remedies", "Governing law", "General provisions"],
     "guidance": "Mutual and balanced. Standard exclusions. Do not add non-compete or non-solicit terms."},
    {"id": "contractor_agreement", "title": "Independent contractor agreement", "agreement_type": "contractor",
     "blurb": "Hire a freelancer or consultant and make sure the company owns the work.",
     "perspective": "customer",
     "fields": [F("company_name", "Your company", required=True), F("contractor_name", "Contractor", required=True),
                F("services", "What they will do", "Be specific; this defines the scope", "textarea", True), F("fee", "Fee and when it is paid", required=True, placeholder="$85 per hour, invoiced monthly, net 30"),
                F("term", "Start date and length", placeholder="Starts June 1, 3 months"), F("ip", "Who owns the work", kind="select", options=["The company owns all work product", "Company owns work; contractor keeps pre-existing tools"], default="Company owns work; contractor keeps pre-existing tools"), STATE_NOTE],
     "outline": ["Services and deliverables", "Fees, invoices and expenses", "Term and termination", "Independent contractor relationship", "Ownership of work product (present assignment)",
                 "Contractor's pre-existing materials and license", "Confidentiality", "Warranties (original work, no infringement, open-source rule)", "Indemnity and limits", "Governing law", "General provisions"],
     "guidance": "Present-tense assignment ('hereby assigns') of work product. Clear scope and acceptance. State that the contractor is not an employee; the company should still check its state's contractor classification tests."},
    {"id": "offer_letter", "title": "Employee offer letter", "agreement_type": "offer_letter",
     "blurb": "A clear offer: role, pay, equity, and the conditions that come with it.",
     "perspective": "employer",
     "fields": [F("company_name", "Company", required=True), F("candidate", "Candidate", required=True), F("title", "Job title", required=True), F("start_date", "Start date", kind="date"),
                F("salary", "Salary", required=True, placeholder="$140,000 per year"), F("equity", "Equity", "Option shares and vesting, if any", default="", placeholder="10,000 options, 4-year vesting, 1-year cliff, subject to board approval"),
                F("reports_to", "Reports to"), F("benefits", "Benefits", "Short summary", "textarea"), STATE_NOTE],
     "outline": ["Position, title and reporting line", "Start date and location", "Compensation", "Equity (subject to board approval and the plan)", "Benefits", "At-will employment",
                 "Conditions: confidentiality and invention assignment agreement, work authorization", "Entire agreement", "Acceptance"],
     "guidance": "Friendly but precise. State at-will employment. Say equity requires board approval and is governed by the plan documents. Do not promise vesting terms the board has not approved."},
    {"id": "advisor_agreement", "title": "Advisor agreement", "agreement_type": "contractor",
     "blurb": "Give an advisor equity for help, with vesting and clear boundaries.",
     "perspective": "customer",
     "fields": [F("company_name", "Company", required=True), F("advisor", "Advisor", required=True), F("services", "What they will help with", kind="textarea", required=True),
                F("equity", "Equity", "Shares or options and vesting", required=True, placeholder="0.25% as options, vesting monthly over 2 years"), F("term", "Length", default="2 years"), STATE_NOTE],
     "outline": ["Advisory services and time expectations", "Equity compensation, vesting and board approval", "Term and termination", "Confidentiality", "Ownership of ideas and work product",
                 "No conflicting obligations", "Independent contractor status", "Governing law", "General provisions"],
     "guidance": "Equity vests over time and stops vesting when the advisory relationship ends. Subject to board approval."},
    {"id": "ip_assignment", "title": "IP assignment agreement", "agreement_type": "ip_assignment",
     "blurb": "Make sure a founder, employee or contractor assigns what they built to the company.",
     "perspective": "customer",
     "fields": [F("company_name", "Company", required=True), F("assignor", "Person assigning", required=True), F("ip_description", "What is being assigned", "Describe the code, designs, inventions, trademarks", "textarea", True),
                F("excluded", "Prior work they keep", "Anything the person owned before and is NOT assigning", "textarea"), F("consideration", "What they receive", placeholder="Founder shares / payment of $1 and other good and valuable consideration"), STATE_NOTE],
     "outline": ["Definitions", "Assignment of intellectual property (present tense)", "Excluded prior inventions and license to any used in the product", "Moral rights waiver", "Further assurances and power of attorney",
                 "Representations (ownership, originality, no conflicting rights)", "Consideration", "Governing law", "General provisions"],
     "guidance": "Use 'hereby assigns'. Include a schedule for excluded prior work and a further-assurances clause."},
    {"id": "privacy_policy", "title": "Website / app privacy policy", "agreement_type": "privacy_policy",
     "blurb": "Tell users what data you collect and why. It must match what you actually do.",
     "perspective": "neutral",
     "fields": [F("company_name", "Company", required=True), F("product", "Website or app", required=True), F("data", "Data you collect", "Check everything that applies", "textarea", True, "Email, name, payment info via Stripe, usage analytics"),
                F("purposes", "Why you collect it", kind="textarea", required=True), F("sharing", "Who you share it with", "Vendors, analytics, payment processors", "textarea"),
                F("retention", "How long you keep it"), F("contact", "Privacy contact email", required=True), F("regions", "Users in", kind="select", options=["United States only", "United States and EU/UK", "Worldwide"], default="United States only")],
     "outline": ["What we collect", "How we use it", "Who we share it with", "Cookies and analytics", "How long we keep it", "Your choices and rights (California, EU/UK if applicable)", "Security", "Children", "Changes to this policy", "Contact us"],
     "guidance": "Describe ONLY the practices the user states. Do not claim practices (such as 'we never sell data') unless the user said so. Flag that the policy must be kept in sync with real practice."},
    {"id": "terms_of_service", "title": "Terms of service", "agreement_type": "terms_of_service",
     "blurb": "The rules for people who use your product, and limits on your liability.",
     "perspective": "vendor",
     "fields": [F("company_name", "Company", required=True), F("product", "Product or service", required=True), F("accounts", "Do users need an account?", kind="select", options=["Yes", "No"], default="Yes"),
                F("payment", "Payment and refunds", kind="textarea", placeholder="Monthly subscription, cancel anytime, no refunds for partial months"), F("prohibited", "Things users may not do", kind="textarea"), STATE_NOTE],
     "outline": ["Acceptance and eligibility", "Accounts and security", "Using the service (acceptable use)", "Payment, renewals and refunds", "Your content and our intellectual property", "Disclaimers",
                 "Limitation of liability", "Termination", "Disputes and governing law", "Changes to the terms", "Contact"],
     "guidance": "Plain language with conspicuous disclaimers and a liability cap. Note that consumer-protection law limits some disclaimers."},
]

CHECKLIST = [
    {"id": "formation", "title": "Company is formed (certificate of incorporation or articles of organization)", "why": "Until the company exists, founders can be personally liable.",
     "types": [], "manual": True, "applies": ["delaware_c_corp", "llc", "s_corp", "other"]},
    {"id": "founders_agreement", "title": "Founders agreement", "why": "Spells out ownership, vesting and what happens if a founder leaves. The most common source of startup disputes.",
     "types": ["founders_agreement"], "draft": "founders_agreement", "applies": ["delaware_c_corp", "llc", "s_corp", "not_yet", "other"]},
    {"id": "operating_agreement", "title": "LLC operating agreement", "why": "Required in practice for an LLC: it overrides default state rules on management, profit and exits.",
     "types": ["operating_agreement"], "draft": "operating_agreement", "applies": ["llc"]},
    {"id": "bylaws", "title": "Bylaws and board consents", "why": "The corporation's internal rules and the record of key decisions such as issuing stock.",
     "types": [], "manual": True, "applies": ["delaware_c_corp", "s_corp"]},
    {"id": "stock_issuance", "title": "Founder stock purchase agreements", "why": "Documents each founder's shares and the vesting repurchase right.",
     "types": ["stock_purchase"], "applies": ["delaware_c_corp", "s_corp"]},
    {"id": "83b", "title": "83(b) election filed within 30 days of receiving vesting stock", "why": "A missed deadline cannot be fixed and can create a large tax bill later. Confirm with your tax adviser.",
     "types": [], "manual": True, "applies": ["delaware_c_corp", "s_corp", "llc"]},
    {"id": "ip_assignment", "title": "IP assignment from every founder and contractor", "why": "Without it, the person who wrote the code or made the logo may own it, not the company.",
     "types": ["ip_assignment"], "draft": "ip_assignment", "applies": ["delaware_c_corp", "llc", "s_corp", "not_yet", "other"]},
    {"id": "contractors", "title": "Contractor agreements", "why": "Defines scope, payment and ownership of work product for freelancers and consultants.",
     "types": ["contractor"], "draft": "contractor_agreement", "applies": ["delaware_c_corp", "llc", "s_corp", "not_yet", "other"]},
    {"id": "offer_letters", "title": "Offer letters for employees", "why": "Sets pay, equity expectations and at-will status; pairs with a confidentiality and invention agreement.",
     "types": ["offer_letter", "employment"], "draft": "offer_letter", "applies": ["delaware_c_corp", "llc", "s_corp", "other"]},
    {"id": "nda", "title": "NDA ready to send", "why": "Lets you talk to partners and vendors without giving away your ideas.",
     "types": ["nda"], "draft": "nda_mutual", "applies": ["delaware_c_corp", "llc", "s_corp", "not_yet", "other"]},
    {"id": "privacy", "title": "Privacy policy", "why": "Required by law in many places if you collect personal data, and by app stores and payment providers.",
     "types": ["privacy_policy"], "draft": "privacy_policy", "applies": ["delaware_c_corp", "llc", "s_corp", "other"]},
    {"id": "tos", "title": "Terms of service", "why": "Sets the rules for users and limits your liability.", "types": ["terms_of_service"], "draft": "terms_of_service",
     "applies": ["delaware_c_corp", "llc", "s_corp", "other"]},
    {"id": "fundraising", "title": "Fundraising documents (SAFE or convertible note)", "why": "Use the standard Y Combinator SAFE or a lawyer's form rather than drafting your own; review before signing. You can upload it here for a plain-English review.",
     "types": ["safe", "convertible_note"], "optional": True, "applies": ["delaware_c_corp", "llc", "s_corp", "other"]},
]


def doc_type(doc_type_id: str) -> dict | None:
    return next((d for d in DOC_TYPES if d["id"] == doc_type_id), None)


def public_doc_types() -> list[dict]:
    return [{k: d[k] for k in ("id", "title", "blurb", "perspective", "fields", "outline")} for d in DOC_TYPES]


def build_instructions(dt: dict, answers: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Compose the drafting instructions and the facts the user supplied (keyed by question label)."""
    facts = {f["label"]: str(answers.get(f["key"], "")).strip() for f in dt["fields"] if str(answers.get(f["key"], "")).strip()}
    outline = "\n".join(f"{i}. {h}" for i, h in enumerate(dt["outline"], 1))
    text = (f"Draft a {dt['title']}. Use this structure and order:\n{outline}\n\nGuidance: {dt['guidance']}\n\n"
            "Use only the facts provided. For every fact that was not provided, insert a [●PLACEHOLDER].")
    return text, facts
