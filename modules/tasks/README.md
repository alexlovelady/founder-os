# Tasks & reminders (`tasks`)

The universal task engine. One list for the owner's own to-dos and for tasks other tools raise (compliance, documents, CRM, finance, AI).

## Table
`tasks_items`: title, description, status (`todo|in_progress|done`), priority (`low|medium|high`), due_date, assigned_to (user id, optional),
source (`manual|ai|compliance|document|crm|finance|system`), source_ref (`{tool, id}`, optional), recurrence
(`none|weekly|monthly|quarterly|yearly`), created_by, completed_at. All rows carry `business_id`.

## API (`/api/tools/tasks/...`)
| Call | What |
|---|---|
| `GET items` | filters: `status` (todo/in_progress/done/open), `due` (overdue/today/week/upcoming/none), `dueFrom`, `dueTo`, `source`, `mine=1`, `sourceTool`+`sourceId`, `limit` |
| `GET items/:id`, `POST items`, `PATCH items/:id`, `DELETE items/:id` | CRUD |
| `POST items/:id/complete` | complete; a recurring task creates the next one (response has `next`) |
| `POST from-source` | for other tools' pages: body `{ title, dueDate, priority, source, sourceRef: { tool, id } }` (or `{ tasks: [...] }`, up to 50). Checks only the shape. If `sourceRef` resolves through `ctx.links`, the task is linked to it (failures are ignored). Asking twice for the same open task (same source, title and ref) returns the existing one. |

Recurrence: completing moves the follow-up one step after the old due date (month ends clamped), repeating until it is not in the past.

## Publishes
* `facts()`: `{ open, overdue, dueThisWeek, completedLast30Days }`
* `describe()`: open / overdue / due-this-week counts plus the three most pressing titles (empty when there are no tasks)
* `attention()`: open tasks overdue or due within 3 days (max 10). Overdue: high priority = high, others = review. Due soon: high = review, others = info.
* `resolve()` / `search()`: tasks by title or notes; links go to `/app/t/tasks/t/<id>`

## Known limits
* `assigned_to` is any user id string; it is not checked against business members (the shell owns membership). The UI only offers "assigned to me".
* No notifications or emails for reminders yet: due tasks show on the dashboard through `attention()`.
* Dates are calendar dates in the database's time zone; there are no due times.
