# Repeat count selection

Apply the browser comment to the total repeat count: select 1–60 with a looping wheel and the same 144px panel as task rewards. Reuse the existing number picker's loop option; retain legacy stored counts until the user selects a new count. Preserve recurrence interval 1–15, points 0–100 in steps of 5, and all API fields.

- [x] Configure `repeatCount` with `max={60}` and `loop` in `frontend/parent/src/features/calendar.tsx`.
- [x] Update the existing picker acceptance for 60→1 and 1→60 keyboard/native scrolling, identical panel width, exact available values, focus, and saved count 60 across desktop/iPad/narrow viewports.
- [x] Run the parent build, domain checks and focused isolated picker regression; inspect screenshots and verify local development assets. Never write fixtures to real development or production records.

Validation passed: parent typecheck/build, domain/runtime tests, source formatting, diff checks, and focused isolated picker acceptance at 1135×789, 820×1180, 1180×820 and 390×844. Both keyboard/native-scroll wrap directions, exact options 1–60, equality with reward panel width, focus restoration and the saved recurrence count of 60 were verified. All 10 accessibility scans and page-error checks were clean. Read-only health and entry asset hashes confirmed development port 18787 serves the final build. Physical iPad Safari was not tested; no production deployment or real business data writes occurred. Screenshots and focused results are in `/private/tmp/lele-repeat-count-qa`.
