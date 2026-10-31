# Plugin Release Remediation Implementation Plan

> **For agentic workers:** Execute the user-approved plan inline, with failing regression checks before implementation and a final review before committing.

**Goal:** Fix the four prelaunch findings without changing or deploying either full Demo plugin.

**Architecture:** Record event-time recipients on the existing transactional outbox, then materialize deliveries after commit in catalog/child lock order. Consume independent events without periodic-task coalescing. Advance a bounded scheduler scan across ticks. Keep v1 SQL immutable and install the recipient field through explicit v2 maintenance.

**Tech Stack:** Python, PostgreSQL, unittest, Playwright, React/Vite host builds.

---

### Task 1: Capture regressions

**Files:** `tests/backend/test_plugin_event_regressions.py`, `tests/backend/test_plugin_schema.py`, `tests/backend/test_plugin_jobs.py`.

- [x] Add isolated-database checks for distinct events, duplicate emission, independent retries, publication/installation/subscription boundaries, delayed dispatch after revocation, and update pauses.
- [x] Add a completion/unpublication concurrency check to reject catalog/child lock inversion.
- [x] Verify bounded rotating scans with more than 1,000 instances and newly enabled/invalid instances.
- [x] Verify v1-to-v2 migration preservation, rollback, preview and repeatability.
- [x] Run selected regressions against the old implementation and observe failures.

### Task 2: Explicit migration and event snapshots

**Files:** `backend/lele_growth/db/migrate_plugin_v1_to_v2.sql`, `backend/lele_growth/maintenance.py`, `backend/lele_growth/plugins/events.py`, `backend/lele_growth/plugins/routes.py`.

- [x] Keep `add_plugin_platform.sql` byte-for-byte unchanged; append a fingerprinted migration and retain both version records.
- [x] Add `plugin_event_outbox.recipients`, defaulting to an empty JSON array. Preserve historical events and deliveries; do not invent historical recipients.
- [x] Snapshot eligible plugin IDs and installation generations inside the existing child transaction, with no catalog row lock or plugin call.
- [x] Expand only recorded recipients after commit. Check the current generation before enqueueing and use existing unique delivery/job identities.
- [x] Pause eligible events during deployment; never revive a recipient after disable/re-enable or configuration revocation.
- [x] Keep core completion usable before explicit plugin v2 maintenance; plugin APIs explain pending maintenance.

### Task 3: Event consumption and scan fairness

**Files:** `backend/lele_growth/plugins/scheduler.py`, `deploy/plugin_runtime.py`.

- [x] Restrict `skip`/`latest` misfire policies to declared periodic tasks; independent events retain all IDs and retries.
- [x] Synchronize terminal/cancelled delivery states with their jobs.
- [x] Scan by `(plugin_id, child_id)` cursor with a per-tick batch/time budget, wrapping at the end and advancing past failures.
- [x] Remove the runtime reconciliation truncation and validate at least one eligible child for each backend plugin.

### Task 4: Browser regression and release validation

**Files:** `tests/browser/plugin_acceptance.cjs`, `tests/browser/account_preset_acceptance.cjs`, `tests/browser/unified_browser_smoke.cjs`, `tests/browser/typography_ui_acceptance.cjs`, `docs/plugins/deployment.md`, `docs/plugins/development.md`.

- [x] Open the real `data-plugin-more` menu before selecting disable; preserve both-parent tab and API revocation assertions.
- [x] Follow the collapsed settings menu in the narrow preset test and explicitly initialize the empty plugin platform in the disposable core browser fixture; retain existing interaction and layout assertions.
- [x] Align the stale admin title assertion with the existing 20px settings detail-heading standard, and run the focused typography suite across all seven viewports.
- [x] Document event subscription boundaries, v2 maintenance order and compatibility.
- [x] Run all backend modules except `test_demo_plugins.py`, domain tests, both type checks, and host builds.
- [x] Run the complete core/plugin browser suites and parent plugin UI suite using isolated fixtures. Do not run or modify `demo-page`/`demo-service`.
- [x] Inspect the actual host release archive and assert that both Demo source/runtime directories are absent.
- [x] Review the final diff, commit the changes to `codex/plugin-mode`, and confirm a clean worktree. Do not merge or deploy.

Validation commands:

```sh
LELE_TEST_CONFIG=data/testing/backend/config.json PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_plugin_event_regressions tests.backend.test_plugin_schema tests.backend.test_plugin_jobs -v
npm run check:parent
npm run check:admin
npm run test:domain
node_modules/.bin/vite build --config frontend/parent/vite.config.mts --outDir /private/tmp/lele-remediation-build/parent
node_modules/.bin/vite build --config frontend/admin/vite.config.mts --outDir /private/tmp/lele-remediation-build/admin
npm run test:browser
npm run test:plugins:ui
.venv/bin/python scripts/package_release.py --output /private/tmp/lele-release-remediation
git diff --check
```

Validation record:

- 259 backend tests passed with `test_demo_plugins.py` excluded. The subsequently added release-exclusion regression passed separately, for 260 total.
- Parent/admin type checks, domain tests, both host builds to temporary output directories, and all 17 parent-plugin UI scenario groups passed.
- The original v1 migration remains byte-identical: SHA-256 `6c04adfcf075c769f0f874ee0b7302c090282bd8563886cde12ccbf0b0bd86f7`.
- All 13 real plugin integration browser scenarios passed, including disable/revocation and deployment update/rollback. Focused typography passed all seven viewports with no page errors.
- Full core browser regression passed all 56 scenarios with no page errors or accessibility violations. This includes PC/iPad/narrow layouts, concurrent writes, stale response isolation, logout and account administration.
- Core regression exposed outdated fixture/navigation/font expectations; the test adaptations preserve interaction, availability and layout checks.
- The inspected host archive contains 80 allowlisted files, including the v2 migration; neither full Demo's source or runtime code is included. Packaging is repeated from the clean commit so the final manifest identifies the exact source revision.
- No production/development migration, merge or deployment was performed.
