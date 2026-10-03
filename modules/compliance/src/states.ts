/**
 * Official business-filing portal per US state (plus DC).
 *
 * `verified: true` means the URL loaded (HTTP 200, no bot challenge) when checked on `VERIFIED_ON`.
 * `verified: false` means we could NOT load it automatically (blocked by bot protection, timed out or redirected to a challenge page).
 * Those links are our best-known official address and are shown to users as "confirm at source".
 * We deliberately do not record fees, due dates or frequencies here: they differ by state and entity type and change over time.
 */
export const VERIFIED_ON = "2026-10-03";

export interface StatePortal {
  code: string;
  name: string;
  office: string;
  url: string;
  verified: boolean;
}

const sos = (n: string) => `${n} Secretary of State`;

export const STATE_PORTALS: StatePortal[] = [
  { code: "AL", name: "Alabama", office: sos("Alabama"), url: "https://www.sos.alabama.gov/business-entities", verified: true },
  { code: "AK", name: "Alaska", office: "Alaska Division of Corporations, Business and Professional Licensing", url: "https://www.commerce.alaska.gov/web/cbpl/corporations.aspx", verified: false },
  { code: "AZ", name: "Arizona", office: "Arizona Corporation Commission", url: "https://azcc.gov/corporations", verified: true },
  { code: "AR", name: "Arkansas", office: sos("Arkansas"), url: "https://www.sos.arkansas.gov/business-commercial-services-bcs", verified: true },
  { code: "CA", name: "California", office: sos("California"), url: "https://www.sos.ca.gov/business-programs/bizfile", verified: true },
  { code: "CO", name: "Colorado", office: sos("Colorado"), url: "https://www.coloradosos.gov/pubs/business/businessHome.html", verified: true },
  { code: "CT", name: "Connecticut", office: "Connecticut business portal (business.ct.gov)", url: "https://business.ct.gov/", verified: true },
  { code: "DE", name: "Delaware", office: "Delaware Division of Corporations", url: "https://corp.delaware.gov/", verified: true },
  { code: "DC", name: "District of Columbia", office: "DC Department of Licensing and Consumer Protection", url: "https://dlcp.dc.gov/", verified: true },
  { code: "FL", name: "Florida", office: "Florida Division of Corporations (Sunbiz)", url: "https://dos.fl.gov/sunbiz/", verified: true },
  { code: "GA", name: "Georgia", office: sos("Georgia"), url: "https://ecorp.sos.ga.gov/", verified: true },
  { code: "HI", name: "Hawaii", office: "Hawaii Business Registration Division", url: "https://cca.hawaii.gov/breg/", verified: true },
  { code: "ID", name: "Idaho", office: sos("Idaho"), url: "https://sos.idaho.gov/business-resources/", verified: true },
  { code: "IL", name: "Illinois", office: sos("Illinois"), url: "https://www.ilsos.gov/departments/business_services/home.html", verified: false },
  { code: "IN", name: "Indiana", office: sos("Indiana"), url: "https://www.in.gov/sos/business/", verified: true },
  { code: "IA", name: "Iowa", office: sos("Iowa"), url: "https://sos.iowa.gov/", verified: true },
  { code: "KS", name: "Kansas", office: sos("Kansas"), url: "https://sos.ks.gov/businesses/information-reports.html", verified: true },
  { code: "KY", name: "Kentucky", office: sos("Kentucky"), url: "https://www.sos.ky.gov/bus/business-filings/Pages/default.aspx", verified: true },
  { code: "LA", name: "Louisiana", office: sos("Louisiana"), url: "https://www.sos.la.gov/", verified: true },
  { code: "ME", name: "Maine", office: "Maine Secretary of State, Corporations", url: "https://www.maine.gov/sos/corporations-commissions", verified: true },
  { code: "MD", name: "Maryland", office: "Maryland Department of Assessments and Taxation", url: "https://dat.maryland.gov/businesses/Pages/default.aspx", verified: true },
  { code: "MA", name: "Massachusetts", office: "Massachusetts Secretary of the Commonwealth, Corporations Division", url: "https://www.sec.state.ma.us/cor/", verified: false },
  { code: "MI", name: "Michigan", office: "Michigan LARA Corporations Division", url: "https://www.michigan.gov/lara/bureau-list/cscl", verified: true },
  { code: "MN", name: "Minnesota", office: sos("Minnesota"), url: "https://www.sos.mn.gov/business-liens/", verified: false },
  { code: "MS", name: "Mississippi", office: sos("Mississippi"), url: "https://www.sos.ms.gov/business-services", verified: false },
  { code: "MO", name: "Missouri", office: sos("Missouri"), url: "https://www.sos.mo.gov/business", verified: true },
  { code: "MT", name: "Montana", office: sos("Montana"), url: "https://sosmt.gov/business/", verified: true },
  { code: "NE", name: "Nebraska", office: sos("Nebraska"), url: "https://sos.nebraska.gov/business-services/business-services-division", verified: true },
  { code: "NV", name: "Nevada", office: sos("Nevada"), url: "https://www.nvsos.gov/sos/businesses", verified: true },
  { code: "NH", name: "New Hampshire", office: sos("New Hampshire"), url: "https://www.sos.nh.gov/corporation-division", verified: false },
  { code: "NJ", name: "New Jersey", office: "New Jersey Division of Revenue and Enterprise Services", url: "https://www.nj.gov/treasury/revenue/", verified: true },
  { code: "NM", name: "New Mexico", office: sos("New Mexico"), url: "https://www.sos.nm.gov/business-services/", verified: true },
  { code: "NY", name: "New York", office: "New York Department of State", url: "https://dos.ny.gov/", verified: false },
  { code: "NC", name: "North Carolina", office: sos("North Carolina"), url: "https://www.sosnc.gov/divisions/business_registration", verified: true },
  { code: "ND", name: "North Dakota", office: sos("North Dakota"), url: "https://www.sos.nd.gov/business", verified: true },
  { code: "OH", name: "Ohio", office: sos("Ohio"), url: "https://www.ohiosos.gov/businesses/", verified: false },
  { code: "OK", name: "Oklahoma", office: sos("Oklahoma"), url: "https://www.sos.ok.gov/business/default.aspx", verified: true },
  { code: "OR", name: "Oregon", office: sos("Oregon"), url: "https://sos.oregon.gov/business/Pages/default.aspx", verified: true },
  { code: "PA", name: "Pennsylvania", office: "Pennsylvania Department of State", url: "https://www.pa.gov/agencies/dos/programs/business", verified: true },
  { code: "RI", name: "Rhode Island", office: sos("Rhode Island"), url: "https://www.sos.ri.gov/divisions/business-services", verified: true },
  { code: "SC", name: "South Carolina", office: sos("South Carolina"), url: "https://sos.sc.gov/online-filings", verified: true },
  { code: "SD", name: "South Dakota", office: sos("South Dakota"), url: "https://sdsos.gov/business-services/", verified: true },
  { code: "TN", name: "Tennessee", office: sos("Tennessee"), url: "https://sos.tn.gov/businesses", verified: true },
  { code: "TX", name: "Texas", office: sos("Texas"), url: "https://www.sos.state.tx.us/corp/index.shtml", verified: true },
  { code: "UT", name: "Utah", office: "Utah Division of Corporations and Commercial Code", url: "https://commerce.utah.gov/corporations/", verified: true },
  { code: "VT", name: "Vermont", office: sos("Vermont"), url: "https://sos.vermont.gov/", verified: true },
  { code: "VA", name: "Virginia", office: "Virginia State Corporation Commission", url: "https://www.scc.virginia.gov/", verified: true },
  { code: "WA", name: "Washington", office: sos("Washington"), url: "https://www.sos.wa.gov/corporations-charities", verified: true },
  { code: "WV", name: "West Virginia", office: sos("West Virginia"), url: "https://sos.wv.gov/business", verified: true },
  { code: "WI", name: "Wisconsin", office: "Wisconsin Department of Financial Institutions", url: "https://dfi.wi.gov/Pages/Home.aspx", verified: true },
  { code: "WY", name: "Wyoming", office: sos("Wyoming"), url: "https://sos.wyo.gov/Business/", verified: true },
];

const BY_KEY = new Map<string, StatePortal>();
for (const s of STATE_PORTALS) {
  BY_KEY.set(s.code.toLowerCase(), s);
  BY_KEY.set(s.name.toLowerCase(), s);
}
BY_KEY.set("washington dc", BY_KEY.get("dc")!);
BY_KEY.set("washington, d.c.", BY_KEY.get("dc")!);
BY_KEY.set("d.c.", BY_KEY.get("dc")!);

/** Accepts "North Carolina", "nc" or "NC"; returns null for anything else (including blank). */
export function findState(input: string | null | undefined): StatePortal | null {
  if (!input) return null;
  return BY_KEY.get(input.trim().toLowerCase()) ?? null;
}
