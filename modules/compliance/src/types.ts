import type { Category, DueState, ItemStatus, Recurrence } from "./engine";

/** What the API returns for one checklist item (safe to import from client components). */
export interface ItemDto {
  id: string;
  ruleId: string | null;
  title: string;
  description: string;
  recommendation: string;
  category: Category;
  status: ItemStatus;
  priority: "high" | "normal";
  /** True when applicability was uncertain (profile data missing, or the rule depends on facts we cannot know). */
  uncertain: boolean;
  dueDate: string | null;
  dueState: DueState;
  recurring: boolean;
  recurrence: Recurrence | null;
  sourceUrl: string;
  sourceTitle: string;
  lastVerified: string | null;
  completedAt: string | null;
  notes: string;
  custom: boolean;
}

export interface SummaryDto {
  total: number;
  complete: number;
  attention: number;
  missing: number;
  notApplicable: number;
  open: number;
  overdue: number;
  dueSoon: number;
  nextDueDate: string | null;
  categoriesMissing: string[];
}

export interface ListDto {
  items: ItemDto[];
  summary: SummaryDto;
  rulesVersion: string;
  today: string;
}
