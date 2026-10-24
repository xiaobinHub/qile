# Manual adjustment direction and positive magnitude

**Goal:** Select increase/decrease before entering a positive point amount; rename business date to date.

**Architecture:** Add a direction Choice before the existing amount input in the same row, default to increase, and keep the magnitude positive. Convert it to the existing signed ledger.manual payload on submit. Preserve runtime revision/idempotency/recovery behavior and existing reason/date fields. Reject blank, zero, negative and fractional inputs. Switching direction keeps the entered magnitude.

- [x] Update the manual editor and description; add the compact direction/amount row, positive validation and 日期 label.
- [x] Update the existing negative-adjustment regression to select decrease and enter a positive magnitude.
- [x] Verify real isolated-test-backend additions/deductions, invalid input, direction switching, failure/retry, duplicate protection and responsive accessibility. Build and verify served development assets; no real-data writes or production deployment.

Browser plugin not available; use the existing isolated Playwright harness and dedicated test database.

## Validation result

Parent build/typecheck, all domain/runtime tests, formatting, typography, repository layout and diff checks passed. New browser acceptance passed at 1135×789, 820×1180, 1180×820 and 390×844 with no page errors and zero violations across 10 accessibility states. Each viewport submits +10 and -5 through the real test backend and verifies exact ledger entries/current balance. Checks cover default increase, positive-only magnitude, blank/zero/negative/fractional/unsafe integer rejection before a request, switching direction without losing the amount, keyboard direction selection, duplicate submit protection, disabling fields while pending, confirmed failure retaining decrease/amount, successful retry, cancel without writes and 日期 copy. A committed negative request with a dropped response was refreshed read-only and retried using the exact original signed body/operation ID, producing one deduction. Recovery's existing remount returns the store to its default gift tab; the test reopens the ledger for subsequent adjustments. Inspected desktop and mobile decrease screenshots.

Read-only health and JavaScript/CSS/font hashes confirmed development port 18787 serves final assets. Backend and data schema are unchanged. All fixture writes used temporary children in the dedicated test database and were cleaned up; no real-data writes or production deployment occurred. The full unrelated browser suite was not rerun; its existing deduction flow was updated to the new UI and the new acceptance is included in future full runs. Physical tablet Safari was not tested.
