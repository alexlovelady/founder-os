/**
 * The free tools use the same pure calculators as the Finance tool inside the app, so a number on the public page matches
 * the number you get after signing in. They are re-exported from the finance package source (no database or UI in that file).
 */
export { runway, breakEven, pricing, hireCompare, taxReserve, HIRE_NOTE, TAX_NOTE } from "@founderos/finance/src/calc";
export type { RunwayResult, BreakEvenResult, PricingResult, HireResult, TaxReserveResult } from "@founderos/finance/src/calc";
