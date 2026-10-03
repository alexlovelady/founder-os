import postgres from "postgres";

declare global {
  var __sql: ReturnType<typeof postgres> | undefined;
}

/** One shared connection pool (reused across hot reloads in dev). */
export function db() {
  if (!globalThis.__sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalThis.__sql = postgres(url, { max: 5, idle_timeout: 20 });
  }
  return globalThis.__sql;
}
