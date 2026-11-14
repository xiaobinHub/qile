# Mison Auto Booking Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded work and review. No commits are requested.

**Goal:** Deliver the approved automatic booking feature in the existing plugin using the project's shared UI and durable background execution.

**Architecture:** Host-managed private strategy state, due-time scheduling and authorization fence existing external operations. Plugin code performs bounded Mison reads, matching and single-lesson booking through existing drafts/operations. Frontend uses the API contract in the approved design document and mounts within the existing plugin.

**Tech Stack:** Python/PostgreSQL plugin bridge and scheduler; React/TypeScript/shared shadcn components; unittest and existing Playwright fixtures.

## Task 1: Durable host control and scheduling

- [x] Add host automation state/controller for config, owner authorization, idempotent start/stop, due times, run leases, event log and counters. Store account-scoped private records; enforce one active strategy per remote account under the same advisory lock as writes.
- [x] Route restricted autoBooking bridge actions, extend job admission only for the registered auto-booking task and bound authorizing owner; leave sync jobs restricted. Recheck strategy/credential/lifecycle before dispatch, allow only book operations, and keep receipt reconciliation available after stop.
- [x] Schedule only persisted due runs with stable occurrence keys; recover interrupted runs without sending a second external write. Reject incompatible old platforms by increasing platform API minor.
- [x] Run isolated host tests for membership revocation, concurrent jobs, stale config, sleep, idempotence and account collision.

## Task 2: Plugin matching and execution

- [x] Implement config/status/log/schedule routes, strict field validation and the documented DTOs. Read schedules in two-date pages and preserve explicit query errors/unopened days.
- [x] Add bounded round continuations, prioritizing dates then teachers then slots. Read complete live and completed courses, reconcile pending receipts and require explicit cancellation before releasing a successful date.
- [x] Build a one-lesson recommended draft and call existing booking operations, with a final host guard and daily occupancy check inside account write admission. Persist pending operation before dispatch; stop and read-only reconcile unknown results.
- [x] Run deterministic clock/jitter and fake upstream regressions for teacher order, occupancy, cancellations, expiry, failures and no duplicate counting.

## Task 3: Unified frontend

- [x] Add the third plugin Tab and a focused auto-booking component using existing shared UI exports, independent native scroll regions, visibility cancellation and account-scoped stale-response protection.
- [x] Implement single-teacher full-width date/slot schedule, compact summary, records drawer and start/stop controls. Implement config editor with favorites, multi-date calendar, weekly time chips, drag and move controls, sleep and notice fields.
- [x] Verify `npm run check:mison`, plugin build, formatter and existing layout/typography constraints. Add fixture routes and browser acceptance within the original host loader.

## Task 4: Integration and review

- [x] Review implementation against the approved spec, then review correctness/security and fix findings. Re-run affected backend/browser tests and existing booking/sync regressions.
- [x] Update plugin/version/platform documentation and report the exact validation and remaining real-device/real-upstream boundaries. Leave changes uncommitted on codex/strategy-booking.

## Validation completed 2026-11-13

- Backend: 139 tests across automatic booking, booking, course collection/sync, login/reads, scheduling and development runtime; another 42 manifest, package, frontend-protocol and worker-runtime tests passed. The 33 automatic-booking tests passed again after the final identity/hold fixes.
- Browser: `AUTO_BOOKING_ACCEPTANCE=1 node tests/browser/mison_frontend_acceptance.cjs` and the same command with `TOUCH_BROWSER=webkit` each passed all eight scenarios at 1440×1000, 820×1180 and 390×844. Original parent loader and actual built plugin were used; business requests were intercepted. No console errors, page errors, or unexpected network calls.
- TypeScript, Prettier, typography/layout checks, stale-booking-cache domain regression and `git diff --check` passed. Plugin 1.1.0 builds/packages as a development artifact, requiring platform API1.3. No database migration is required.
- Independent specification and correctness reviews approved after fixing partial-list hold retention, conflicting cancellation identities, CID-less cancellation receipts, completed-history reconciliation, metadata consistency and quota rejection parsing.
- Two existing full-browser failures were reproduced with the unchanged HEAD harness and preserved1.0.36 assets: disabling the plugin leaves one retained root where the old test expects complete unmount; the calendar fixture uses a rejected `data:` avatar URL and expects an image instead of the fallback. These failures also occur without the new feature; no unrelated lifecycle or avatar policy changes were made.
- Evidence: Chromium screenshots in `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-I5XQce/`; WebKit screenshots in `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-0PSV8B/`; old-version baseline metadata/logs in `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-1036-baseline-ovurfiqq/`.
- Physical iPad touch/home-screen behavior and real Mison end-to-end booking remain unverified. No real Mison queries, appointments, production deployment, commits or pushes were performed. Automatic booking remains opt-in and stopped by default.
