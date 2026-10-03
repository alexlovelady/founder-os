import { describe, expect, it } from "vitest";
import { alreadyApplied, classify } from "../src/classify";

const cases: { name: string; filename: string; text: string; expect: { docType: string; category: string } | null }[] = [
  {
    name: "operating agreement",
    filename: "scan0042.pdf",
    text: "OPERATING AGREEMENT OF SUNRISE PLUMBING LLC\nA North Carolina Limited Liability Company\nThis Operating Agreement is made by the Members. Each Member makes the capital contributions listed on Schedule A. The Managing Member shall...",
    expect: { docType: "operating agreement", category: "Formation" },
  },
  {
    name: "articles of organization",
    filename: "filed.pdf",
    text: "State of North Carolina\nDepartment of the Secretary of State\nARTICLES OF ORGANIZATION\nThe name of the limited liability company is Sunrise Plumbing LLC. The registered agent is Pat Doe.",
    expect: { docType: "articles of organization", category: "Formation" },
  },
  {
    name: "EIN letter",
    filename: "irs-letter.pdf",
    text: "Internal Revenue Service\nDepartment of the Treasury\nNotice CP 575 A\nWe assigned you an Employer Identification Number (EIN): 12-3456789. Keep this notice in your permanent records.",
    expect: { docType: "EIN letter", category: "Taxes" },
  },
  {
    name: "NDA",
    filename: "acme-nda-signed.docx",
    text: "MUTUAL NON-DISCLOSURE AGREEMENT\nThis Mutual Non-Disclosure Agreement is entered into between Acme Corp (the Disclosing Party) and Sunrise Plumbing LLC (the Receiving Party). Confidential Information means...",
    expect: { docType: "NDA", category: "Contracts" },
  },
  {
    name: "contractor agreement",
    filename: "agreement.docx",
    text: "INDEPENDENT CONTRACTOR AGREEMENT\nThe Contractor is an independent contractor and not an employee of the Company. Scope of Services: the Contractor will install fixtures as directed in each work order.",
    expect: { docType: "independent contractor agreement", category: "Contractors" },
  },
  {
    name: "employment offer",
    filename: "offer.pdf",
    text: "Offer Letter\nDear Sam, we are pleased to extend an offer of employment as Service Technician. Your base salary will be $52,000. Employment is at-will.",
    expect: { docType: "employment agreement", category: "Employees" },
  },
  {
    name: "privacy policy",
    filename: "website-policy.txt",
    text: "Privacy Policy\nLast updated January 2026. This Privacy Policy explains what personal information we collect when you visit our website, how we use cookies, and your rights under the CCPA.",
    expect: { docType: "privacy policy", category: "Policies" },
  },
  {
    name: "terms of service",
    filename: "tos.md",
    text: "# Terms of Service\nBy using the site you agree to be bound by these terms. Acceptable use: you may not misuse the service. Limitation of liability applies.",
    expect: { docType: "terms of service", category: "Policies" },
  },
  {
    name: "insurance certificate",
    filename: "coi.pdf",
    text: "CERTIFICATE OF LIABILITY INSURANCE\nInsured: Sunrise Plumbing LLC. Policy Number GL-99812. Policy Period 01/01/2026 to 01/01/2027. General Liability each occurrence $1,000,000.",
    expect: { docType: "insurance policy", category: "Insurance" },
  },
  {
    name: "lease",
    filename: "shop.pdf",
    text: "COMMERCIAL LEASE AGREEMENT\nThis Lease is between Main Street Holdings (Landlord) and Sunrise Plumbing LLC (Tenant) for the premises at 12 Main St. Base Rent is $2,400 per month. Security deposit: $2,400.",
    expect: { docType: "lease", category: "Contracts" },
  },
  {
    name: "invoice",
    filename: "INV-2026-014.pdf",
    text: "Invoice\nInvoice Number: 2026-014\nBill To: Sunrise Plumbing LLC\nAmount Due: $1,250.00  Due Date: March 3, 2026",
    expect: { docType: "invoice", category: "Finance" },
  },
  {
    name: "W-9",
    filename: "w9.pdf",
    text: "Form W-9 (Rev. March 2024)\nRequest for Taxpayer Identification Number and Certification\nDepartment of the Treasury, Internal Revenue Service",
    expect: { docType: "W-9", category: "Taxes" },
  },
  {
    name: "filename alone is enough when the text is unreadable",
    filename: "Operating-Agreement-2025.pdf",
    text: "",
    expect: { docType: "operating agreement", category: "Formation" },
  },
  { name: "ordinary text gets no suggestion", filename: "notes.txt", text: "Remember to call the supplier about the delivery date and pick up the truck on Friday.", expect: null },
  { name: "a passing mention is not a classification", filename: "meeting-notes.txt", text: "We should update our privacy policy at some point, and maybe look at insurance.", expect: null },
  { name: "empty input", filename: "x.pdf", text: "", expect: null },
];

describe("document classifier", () => {
  it.each(cases)("$name", (c) => {
    const s = classify(c.text, c.filename);
    if (c.expect === null) expect(s).toBeNull();
    else {
      expect(s).toMatchObject(c.expect);
      expect(s!.evidence.length).toBeGreaterThan(0);
    }
  });

  it("explains itself with the matched phrases and a confidence", () => {
    const s = classify(cases[3].text, cases[3].filename)!;
    expect(s.confidence).toBe("high");
    expect(s.evidence.join(" ").toLowerCase()).toContain("non-disclosure agreement");
    expect(s.evidence.some((e) => e.startsWith("filename"))).toBe(true);
  });

  it("does not repeat a suggestion the user already applied", () => {
    const s = classify(cases[0].text, "x.pdf")!;
    expect(alreadyApplied(s, { category: "Formation", docType: "Operating Agreement" })).toBe(true);
    expect(alreadyApplied(s, { category: "Other", docType: "" })).toBe(false);
  });

  it("is fast on a large document", () => {
    const t0 = Date.now();
    classify("lorem ipsum dolor sit amet ".repeat(80_000), "big.txt");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
