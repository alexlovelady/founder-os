/** Pure calculators. No database or UI here, so they run in the browser (live results) and on the server (what gets saved). */

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export interface RunwayInput { cash: number; monthlyRecurringRevenue: number; otherMonthlyRevenue: number; monthlyExpenses: number }
export interface RunwayResult { monthlyRevenue: number; netBurn: number; runwayMonths: number | null; profitable: boolean; breakEvenRevenueGap: number }

export function runway(i: RunwayInput): RunwayResult {
  const monthlyRevenue = num(i.monthlyRecurringRevenue) + num(i.otherMonthlyRevenue);
  const netBurn = round(num(i.monthlyExpenses) - monthlyRevenue);
  const profitable = netBurn <= 0;
  return {
    monthlyRevenue: round(monthlyRevenue),
    netBurn,
    profitable,
    runwayMonths: profitable ? null : round(Math.max(0, num(i.cash)) / netBurn, 1),
    breakEvenRevenueGap: profitable ? 0 : netBurn,
  };
}

export interface BreakEvenInput { fixedExpenses: number; variableCostPerSale: number; pricePerSale: number }
export interface BreakEvenResult { contributionPerSale: number; contributionMarginPct: number | null; breakEvenSales: number | null; breakEvenRevenue: number | null; reason?: string }

export function breakEven(i: BreakEvenInput): BreakEvenResult {
  const contribution = num(i.pricePerSale) - num(i.variableCostPerSale);
  if (contribution <= 0) {
    return { contributionPerSale: round(contribution), contributionMarginPct: null, breakEvenSales: null, breakEvenRevenue: null, reason: "Each sale costs as much as it earns, so it never breaks even. Raise the price or lower the cost per sale." };
  }
  const sales = Math.ceil(num(i.fixedExpenses) / contribution);
  return {
    contributionPerSale: round(contribution),
    contributionMarginPct: round((contribution / num(i.pricePerSale)) * 100, 1),
    breakEvenSales: sales,
    breakEvenRevenue: round(sales * num(i.pricePerSale)),
  };
}

export interface PricingInput { labor: number; materials: number; overhead: number; desiredMarginPct: number }
export interface PricingResult { totalCost: number; minimumPrice: number; targetPrice: number | null; profitAtTarget: number | null; reason?: string }

export function pricing(i: PricingInput): PricingResult {
  const totalCost = num(i.labor) + num(i.materials) + num(i.overhead);
  const m = num(i.desiredMarginPct) / 100;
  if (m >= 1) return { totalCost: round(totalCost), minimumPrice: round(totalCost), targetPrice: null, profitAtTarget: null, reason: "A margin of 100% or more is not possible. Choose a margin under 100%." };
  const target = totalCost / (1 - Math.max(0, m));
  return { totalCost: round(totalCost), minimumPrice: round(totalCost), targetPrice: round(target), profitAtTarget: round(target - totalCost) };
}

export interface HireInput { employeeAnnualPay: number; employerPayrollTaxPct: number; annualBenefits: number; otherAnnualEmployeeCosts: number; contractorHourlyRate: number; contractorHoursPerYear: number }
export interface HireResult { employeeTotalCost: number; contractorTotalCost: number; difference: number; cheaper: "employee" | "contractor" | "equal"; note: string }

export const HIRE_NOTE =
  "This compares cost only. Whether someone can be treated as a contractor or must be an employee is decided by the law and their actual working relationship, not by which costs less. Ask a lawyer or accountant before classifying someone.";

export function hireCompare(i: HireInput): HireResult {
  const pay = num(i.employeeAnnualPay);
  const employeeTotalCost = round(pay + pay * (num(i.employerPayrollTaxPct) / 100) + num(i.annualBenefits) + num(i.otherAnnualEmployeeCosts));
  const contractorTotalCost = round(num(i.contractorHourlyRate) * num(i.contractorHoursPerYear));
  const difference = round(employeeTotalCost - contractorTotalCost);
  return { employeeTotalCost, contractorTotalCost, difference, cheaper: difference > 0 ? "contractor" : difference < 0 ? "employee" : "equal", note: HIRE_NOTE };
}

export interface TaxReserveInput { periodIncome: number; reservePct: number }
export interface TaxReserveResult { reserveAmount: number; keepAmount: number; note: string }

export const TAX_NOTE = "An estimate of how much to set aside, using the percentage you chose. It is not a tax calculation or a tax return. Confirm the right percentage with your accountant.";

export function taxReserve(i: TaxReserveInput): TaxReserveResult {
  const pct = Math.min(100, Math.max(0, num(i.reservePct)));
  const reserveAmount = round(num(i.periodIncome) * (pct / 100));
  return { reserveAmount, keepAmount: round(num(i.periodIncome) - reserveAmount), note: TAX_NOTE };
}

export const KINDS = ["runway", "break_even", "pricing", "hire_compare", "tax_reserve"] as const;
export type Kind = (typeof KINDS)[number];
