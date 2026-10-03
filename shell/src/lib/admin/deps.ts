import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import type { AdminDeps } from "./guard";

/** Production dependencies for the admin API routes. */
export const defaultDeps = (): AdminDeps => ({ getSession, sql: () => db() });
