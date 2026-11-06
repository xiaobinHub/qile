# Mison course identity sync implementation plan

> **For agentic workers:** Execute inline in this session. The user has approved this design and implementation; no further design handoff is required.

**Goal:** Match Mison lessons and tasks by account/contract, teacher, date/full time slot and courseware, including cancellations without CID, without losing task identity or duplicating points.

**Architecture:** Keep the existing CID-based task IDs and completion source unchanged. A host-owned, per-CID private association stores teacher/courseware and booking evidence; a pure resolver supplies exact CID changes to the existing task/points reconciler. Persist associations, cancellation tombstones, a snapshot revision and task/points changes in the same bridge transaction. Capture the revision before upstream reads and reject results collected against an older revision.

**Tech Stack:** Python, existing PostgreSQL v3 plugin private records, unittest integration fixtures, TypeScript summary rendering.

---

### Task 1: Collection and identity resolution

**Files:**
- Modify: `plugins/mison-booking/backend/mison_booking/course_sync.py`
- Create: `backend/lele_growth/course_sync_identity.py`
- Reuse unchanged: `backend/lele_growth/course_sync.py` (CID task IDs, task/points reconciliation)
- Test: `tests/backend/test_mison_course_sync.py`, `tests/backend/test_course_sync_identity.py`

- [x] Add failing cases for missing-CID cancellation, exact full-slot matching, ambiguous teacher names, same-slot courseware replacement, cancel/rebook with another CID, duplicate cancellation and preserved task/points identity.
- [x] Preserve `tid`, `courseware_id`, `bid`, `courseid` and all time components in collected lessons. A cancellation may have no CID; a live lesson must have one.
- [x] Resolve teacher names only against unique IDs from known lesson associations. Backfill legacy tasks only when the full slot and rendered course title identify one upstream course with a resolved teacher ID.
- [x] Resolve cancellation to one stored CID. Protect live bookings of the same composite from older CID-less cancellation; ambiguous candidates remain unchanged and appear in the summary.
- [x] Replace an old CID in the same unique teacher/full slot when the current booking uses a different courseware. Preserve unchanged CID-based task IDs and historic completion sources.
- [x] Keep per-CID cancellation tombstones so a future stale completed/upcoming row cannot recreate or re-award a cancelled CID.

Run: `PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_course_sync tests.backend.test_course_sync_identity tests.backend.test_mison_course_sync -v`

### Task 2: Transaction and concurrency fences

**Files:**
- Modify: `backend/lele_growth/course_sync_host.py`
- Create: `backend/lele_growth/course_sync_identity_store.py`
- Test: `tests/backend/test_mison_sync_integration.py`

- [x] Load only child/plugin-scoped association records; use individual records to respect the 64 KiB record limit.
- [x] Expose `snapshotRevision` via `courseSync.get`, capture it before collection, and require the same revision at preview/commit. Preview reads without storing records or advancing the revision.
- [x] Persist changed associations, snapshot revision, settings, receipt and task/points changes atomically; preserve existing binding/credential/settings fences and signed-job restrictions.
- [x] Verify stale snapshots cannot resurrect cancelled completed lessons, re-award points, or overwrite newer courseware. Verify rollback includes all metadata and repeat sync is idempotent.
- [x] Surface unresolved matches in the existing sync summary without creating a new management flow.

Run: `LELE_TEST_CONFIG=data/testing/backend/config.json LELE_TEST_DB_CONFIG=data/testing/backend/postgres-config.json PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_mison_sync_integration -v`

### Task 3: Package and guarded local repair

**Files:**
- Modify: `plugins/mison-booking/plugin.json`, `plugins/mison-booking/README.md`
- Create: `scripts/repair_mison_incomplete_cancel.py` (guarded preview/apply for the verified development-only case)

- [x] Run relevant backend regression and type/format checks. Build the next development plugin version and inspect its package.
- [x] Query the already authorized official read APIs with the saved local credential, without login or Mison mutations. Preview the exact Miri CID `1086176` repair for child `d13e2810-5817-4ebf-92f4-5770c60efc7b`, preserving CessAnne CID `1097702`.
- [x] Require local PostgreSQL `lele_dev`, the verified development config, expected business revision and unchanged cancellation/live evidence. Save a local pre-repair snapshot. Apply through the normal host transaction; no blanket SQL deletions.
- [x] Verify only the cancelled Miri task was removed, all other business records and points remain unchanged, and repeated reconciliation cannot restore it.
- [x] Record actual validation and local runtime/package status here. No production deployment, upstream booking/cancellation, or unrelated review fixes.

### Results

- Final backend suite: **438 tests passed** (`/tmp/lele-mison-identity-backend-final.log`). Added resolver, collection, integration, runtime protocol and repair-guard coverage.
- Mison/parent TypeScript, domain tests, formatting, typography, layout and `git diff --check` passed.
- Targeted real-parent/browser settings acceptance passed, including review details, preview, uncertain exact retry and revision conflicts (`/tmp/lele-mison-identity-settings-browser.log`). This does not close the unrelated avatar/iPad review findings.
- Development package: `output/plugin-releases/mison-booking/1.0.34/mison-booking-1.0.34-dirty.tar.gz`; inspected SHA256 `df2b4c8ec8517d714cc5f62eedb2a4c54dd3758ca75d5bbf0829b038d29658b0`, platform API 1.2 / frontend 1.1, purpose development. No schema migration.
- Local runtime handshake now reports/checks both platform and frontend minor versions. The normal `scripts/dev.py plugins-deploy` chain updated only the local development installation from 1.0.33 to **1.0.34**, release `4e01f1f3-13dd-4e32-bd40-9c150cfd830e`. Installation generation, enabled state, configuration, login binding, encrypted credential revision and vault digest were preserved.
- Authorized official read APIs confirmed Miri teacher ID **4314** from historical lessons. Full-snapshot preview removed only cancelled CID **1086176** on **2026-11-10**; no other business sections changed.
- Guarded local repair applied at business revision **462 -> 463**. Backup: `data/development/repairs/mison-1086176-revision-462-1793983248881911000.json` (0600). Only the Miri incomplete series was deleted; CessAnne CID **1097702**, all unrelated tasks, completion history and the entire points ledger were unchanged. Balance remains **2245**.
- An immediate repeated host reconciliation and another fresh sync through the installed worker/Bridge/database both reported zero changes and did not recreate Miri. Installed-worker result: `state=synced`, `added=0`, `removed=0`, `points=0`, `clawback=0`, `needsReview=0`, business revision still 463.
- No Mison login/booking/cancellation mutation or production deployment occurred. Code remains uncommitted on `codex/meisen-course-booking-plugin`.
