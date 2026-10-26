-- Add a field to the existing table. No database replacement or historical backfill.
ALTER TABLE lele.points_ledger ADD COLUMN task_date date;
ALTER TABLE lele.points_ledger ADD CONSTRAINT points_ledger_task_date_kind_check
 CHECK (task_date IS NULL OR kind IN ('task-complete','task-reversal'));
COMMENT ON COLUMN lele.points_ledger.task_date IS
 'Actual task date captured for new completion/reversal rows. Historical NULL means unknown.';
