import { cmp, occurrences } from "./calendar"
import type { BusinessData, Occurrence, Preset, Task } from "./types"

export type CalendarDraft = {
  added: Occurrence[]
  changes: Record<
    string,
    { source: Occurrence; date: string | null; task?: Task; restore?: Occurrence }
  >
}
export const emptyCalendarDraft = (): CalendarDraft => ({ added: [], changes: {} })
export function addDraftTask(draft: CalendarDraft, preset: Preset, date: string, id: string) {
  const occurrence: Occurrence = {
    seriesId: id,
    occurrenceKey: id,
    originalDate: date,
    date,
    title: preset.title,
    note: "",
    startTime: preset.startTime,
    endTime: preset.endTime,
    categoryId: preset.categoryId,
    points: preset.points,
    recurring: false,
  }
  return { ...draft, added: [...draft.added, occurrence] }
}
export function placeDraftTask(draft: CalendarDraft, occurrence: Occurrence, date: string | null) {
  const key = occurrence.occurrenceKey
  if (draft.added.some((item) => item.occurrenceKey === key))
    return {
      ...draft,
      added: date
        ? draft.added.map((item) => (item.occurrenceKey === key ? { ...item, date } : item))
        : draft.added.filter((item) => item.occurrenceKey !== key),
    }
  const source = draft.changes[key]?.source || occurrence,
    changes = { ...draft.changes }
  const task = changes[key]?.task
  if (
    date === source.date &&
    (!task ||
      JSON.stringify({ ...task, startDate: date }) === JSON.stringify(taskFromOccurrence(source)))
  )
    delete changes[key]
  else
    changes[key] = {
      ...changes[key],
      source,
      date,
      ...(date === null
        ? {
            restore: changes[key]?.restore || {
              ...(task ? withTask(source, task) : occurrence),
              date: changes[key]?.date || occurrence.date,
            },
          }
        : {}),
    }
  return { ...draft, changes }
}
export function deletedDraftTasks(draft: CalendarDraft): Occurrence[] {
  return Object.values(draft.changes).flatMap((change) =>
    change.date === null ? [change.restore || change.source] : [],
  )
}
export function restoreDraftTask(draft: CalendarDraft, key: string) {
  const change = draft.changes[key]
  if (!change || change.date !== null) return draft
  const occurrence = change.restore || change.source
  return editDraftTask(draft, occurrence, taskFromOccurrence(occurrence))
}
function withTask(source: Occurrence, task: Task): Occurrence {
  return {
    ...source,
    date: task.startDate,
    title: task.title,
    note: task.note,
    startTime: task.startTime,
    endTime: task.endTime,
    categoryId: task.categoryId,
    points: task.points,
  }
}
export function editDraftTask(draft: CalendarDraft, occurrence: Occurrence, task: Task) {
  const key = occurrence.occurrenceKey
  if (draft.added.some((item) => item.occurrenceKey === key))
    return {
      ...draft,
      added: draft.added.map((item) => (item.occurrenceKey === key ? withTask(item, task) : item)),
    }
  const source = draft.changes[key]?.source || occurrence
  const changes = { ...draft.changes }
  const edited = taskFromOccurrence(withTask(source, task))
  if (JSON.stringify(edited) === JSON.stringify(taskFromOccurrence(source))) delete changes[key]
  else changes[key] = { source, date: task.startDate, task: edited }
  return { ...draft, changes }
}
export function draftOccurrences(
  data: BusinessData,
  from: string,
  to: string,
  draft: CalendarDraft,
) {
  return [
    ...occurrences(data, from, to).filter((item) => !draft.changes[item.occurrenceKey]),
    ...Object.values(draft.changes).flatMap(({ source, date, task }) =>
      date && date >= from && date <= to
        ? [{ ...(task ? withTask(source, task) : source), date }]
        : [],
    ),
    ...draft.added.filter((item) => item.date >= from && item.date <= to),
  ].sort((a, b) => cmp(a.date, b.date) || cmp(a.startTime, b.startTime) || cmp(a.title, b.title))
}
const taskFromOccurrence = (item: Occurrence, date = item.date): Task => ({
  title: item.title,
  note: item.note,
  startDate: date,
  startTime: item.startTime,
  endTime: item.endTime,
  categoryId: item.categoryId,
  points: item.points,
  recurrence: null,
})
export function calendarDraftOperations(draft: CalendarDraft) {
  return [
    ...Object.values(draft.changes).map(({ source, date, task }) =>
      date
        ? {
            kind: "task.edit",
            payload: {
              occurrenceKey: source.occurrenceKey,
              scope: "only",
              task: task ? { ...task, startDate: date } : taskFromOccurrence(source, date),
            },
          }
        : {
            kind: "task.delete",
            payload: { occurrenceKey: source.occurrenceKey, scope: "only" },
          },
    ),
    ...draft.added.map((item) => ({
      kind: "task.create",
      payload: { task: taskFromOccurrence(item) },
    })),
  ]
}
export function calendarDraftSummary(draft: CalendarDraft) {
  const changes = Object.values(draft.changes)
  return {
    added: draft.added.length,
    moved: changes.filter((change) => change.date !== null).length,
    deleted: changes.filter((change) => change.date === null).length,
    total: draft.added.length + changes.length,
  }
}
