/**
 * Billing: plans, usage metering, quota enforcement and Stripe. Entry point; see docs/BILLING.md.
 * Everything is inactive and honest without STRIPE_SECRET_KEY: businesses are on the Free plan and checkout refuses with a clear message.
 */
export * from "./core";
export * from "./stripe";
export * from "./config";
export { METRICS, resolveMetric, monthWindow, type MetricDef, type MetricKind } from "./metrics";
