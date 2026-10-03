export const RECURRENCES = ["none", "weekly", "monthly", "quarterly", "yearly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);

function addMonths(date: string, n: number): string {
  const m = DATE_RE.exec(date)!;
  const y = +m[1];
  const mo = +m[2] - 1 + n;
  const day = +m[3];
  const target = new Date(Date.UTC(y, mo, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last))));
}

/** One recurrence step after `date` (month ends are clamped: Jan 31 + 1 month = Feb 28/29). */
export function addInterval(date: string, rec: Recurrence): string {
  switch (rec) {
    case "weekly": {
      const m = DATE_RE.exec(date)!;
      return fmt(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 7)));
    }
    case "monthly": return addMonths(date, 1);
    case "quarterly": return addMonths(date, 3);
    case "yearly": return addMonths(date, 12);
    default: return date;
  }
}

/**
 * Due date of the follow-up task created when a recurring task is completed: one step after the old due date, repeated until it is
 * not in the past (so a task completed very late does not spawn an already-overdue copy). With no due date, one step after today.
 */
export function nextDueDate(due: string | null, rec: Recurrence, today: string): string {
  if (rec === "none") return due ?? today;
  if (!due) return addInterval(today, rec);
  let next = addInterval(due, rec);
  for (let i = 0; i < 1000 && next < today; i++) next = addInterval(next, rec);
  return next;
}
