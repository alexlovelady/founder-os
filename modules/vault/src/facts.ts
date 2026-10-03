export const CATEGORIES = ["Formation", "Legal", "Contracts", "Taxes", "Finance", "Insurance", "Employees", "Contractors", "Customers", "Vendors", "Policies", "SOPs", "Marketing", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface FactRow {
  name: string;
  doc_type: string;
  category: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const text = (r: FactRow) => `${norm(r.doc_type)} | ${norm(r.name)}`;

const OPERATING = /operating agreement|llc agreement|company agreement/;
const PRIVACY = /privacy (policy|notice)/;
const CONTRACTOR = /contractor agreement|independent contractor|contractor services agreement|1099 (contractor )?agreement/;
const INSURANCE = /insurance|liability polic|\bcoi\b/;
const FORMATION = /articles of (organization|incorporation)|certificate of (formation|incorporation)|\bformation\b|\bein\b|ss 4|cp ?575|operating agreement/;
const EIN = /\bein\b|ss 4|cp ?575|employer identification/;

/** Which key documents exist, judged from category, doc type and name keywords. Not a legal check of what the documents contain. */
export function keyDocumentFlags(rows: FactRow[]) {
  const any = (re: RegExp, cats: string[] = []) => rows.some((r) => re.test(text(r)) || cats.includes(r.category.toLowerCase()));
  return {
    hasOperatingAgreement: any(OPERATING),
    hasPrivacyPolicy: any(PRIVACY),
    hasContractorAgreement: any(CONTRACTOR),
    hasInsurance: any(INSURANCE, ["insurance"]),
    hasFormationDocs: any(FORMATION, ["formation"]),
    hasEin: any(EIN),
  };
}

export function normalizeDocType(s: string): string {
  return norm(s);
}
