# Legal sources, and why the models are not trained on them

## Do we need to train or fine-tune a model on legal documents?
No, and for this system it would be the wrong tool.

* **The system answers from retrieved text, not from what a model memorized.** Every answer is built from numbered passages
  that retrieval pulled out of your documents and the authority library, and code then checks each citation and each quotation
  against those passages. A model that "knows" law from training can still invent a citation or quote a statute from an old
  version. Retrieval plus verification does not rely on that.
* **Law changes.** A fine-tuned model freezes a snapshot. The library instead refreshes from official sources on a schedule and
  keeps dated versions, so a question about 2024 gets the 2024 text.
* **Fine-tuning does not give you verifiable sources.** It cannot tell you which passage supports a sentence. Retrieval can.
* **Cost and hardware.** Fine-tuning a 30B model needs far more than 16 GB of VRAM; a small tuned model would be weaker at the
  reasoning that matters here.

What *would* help the models is better inputs: the right authorities in the library, good prompts and playbooks, and a benchmark
that tells you when a change makes things worse. All three exist (Authorities page, Playbooks, `benchmarks/`).

Possible later, only if measurements justify it: a better embedding or reranking model, or a small fine-tune of the *embedding*
model on your own question/passage pairs. The benchmark in `benchmarks/` is how you would know.

## What to put in the library (and how)
Add sources on the **Authorities** page (administrator). All are fetched from official sources and kept with version history.

| Need | Source type | Notes |
|---|---|---|
| Federal regulations (CFR) | eCFR adapter (title + part) | Official eCFR API, no key. Verified against the live API. |
| Federal statutes (U.S. Code) | U.S. Code adapter (title + sections) | Official GPO govinfo link service, no key. Verified live. Give section ranges like `101-122`. |
| Specific official documents (agency guidance, court rules, state statutes published as pages or PDFs) | Official https URL | Public https only. Conditional GET, so unchanged sources cost nothing. |
| Court opinions | CourtListener adapter | Needs a free API token (`COURTLISTENER_TOKEN`). **Not verified against the live API** (no token was available); covered by mocked tests only. |
| Subsequent history ("is this still good law?") | Treatment entries / bulk import | Never inferred by the system. Enter it from an authoritative source, or import a CSV/JSON export from a citator you license. |

The Authorities page has one-click starting points (FTC Safeguards, COPPA, FLSA, copyright, trade secrets, and others). They are
examples, not a complete selection.

**State law.** There is no single free official bulk source for all states. Many states publish their code on an official site;
add the specific sections or chapters you need with the URL adapter, or tell me which states matter and I will look for an
official API or download for them.

**Size and cost.** A large part (HIPAA's Part 164, Regulation Z) is hundreds of thousands of characters. Each passage is embedded
twice (Voyage and the local model) so private matters can search it, which costs a few cents at Voyage and some GPU time locally.

## What the system will and will not claim
* It labels external authority with when it was last verified from the official source and shows "Currentness not verified" when
  that is old or missing.
* It never says a case is good law. If no treatment is recorded it says "No treatment data".
* The library is **public text only**. Your private documents never go into it.

## Small businesses and startups: what to load instead of training
Founder agreements, operating agreements, SAFEs and similar documents are well served by knowledge, not training:

* **Built-in checklists.** The review recognizes these document types and applies a matching checklist automatically: founders
  agreement (vesting and cliff, IP assignment, roles, decision rules, departure and buyout, deadlock), LLC operating agreement
  (capital contributions, distributions and tax distributions, management, transfer restrictions, buy-sell, fiduciary duties, tax
  matters, dissolution), SAFE and convertible note (valuation cap and discount, conversion, pro rata, dissolution), contractor and
  IP assignment (present-tense assignment, originality warranty, open source). They also drive the "missing provision" findings.
  Edit them or write your own on the Playbooks list; they are starting positions for a lawyer's judgment, not advice.
* **Your approved templates.** Upload your firm's or company's own templates as documents (authority type "template") in a matter;
  drafting retrieves them as reference material. Widely published free forms are good additions: the Y Combinator SAFE, the NVCA
  model documents, Cooley GO and Series Seed forms. Check each form's terms of use before adding it; the system will not fetch
  them for you.
* **Startup law in the library.** One-click presets: Regulation D (Rules 501-508), Rule 701 (employee equity), Rule 144, the
  Section 83 / 83(b) regulations, the Delaware LLC Act and DGCL core subchapters, and the North Carolina LLC Act and Business
  Corporation Act (all from official sites). Tell me which other states your clients use and I will add their entity statutes.
* **What is not covered.** State securities ("blue sky") rules, tax code beyond the Section 83 regulations, and case law
  (Delaware Chancery decisions matter a lot for founders) are not in the library yet. Court opinions need the CourtListener
  token, and "is this still good law" needs treatment data from a citator you license.
