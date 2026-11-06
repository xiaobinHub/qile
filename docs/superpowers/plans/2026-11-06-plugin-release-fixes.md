# Plugin release review fixes — Implementation Plan

**Goal:** Implement the five fixes selected by the user from the release review, preserving existing tasks, points and plugin lifecycle behavior.

**Approved design:** The user selected review items 1, 2, 3, 4 and 6 after reviewing their proposed fixes. Continue implementation in this chat. No further design or execution approval is needed.

**Architecture:** The host bridge transaction owns login-binding checks, settings revision checks and persistent save receipts. Scheduled jobs retain signed runtime admission and receive only the actions needed for course sync. Frontend protocol 1.1 explicitly covers overlays and page visibility, with both entry and runtime requests declaring client support.

**Tech stack:** Python/FastAPI/PostgreSQL, React/TypeScript, plugin SDK, unittest and the existing isolated Playwright fixtures.

## Scope

- Fix 1: Carry credential id/revision and binding revision from collection to commit; recheck the active session and credential in the host transaction.
- Fix 2: Admit signed background jobs only for course-sync reads/runs and their session reads/invalidation. Keep account management owner-only.
- Fix 3: Automatic runs read current saved settings in the host. Saving/previewing keeps explicit strict settings validation.
- Fix 4: Save requests carry operation id, expected settings revision and expected account binding. Persist the canonical settings request hash and result in plugin-private records in the same transaction as business data/settings. Replay only the saved result; reject conflicting ids or stale new operations. The UI retains an uncertain save request for retry and rereads authoritative settings.
- Fix 6: Introduce frontend protocol 1.1, advertise it in entry/runtime requests, reject unsupported old clients before loading/executing a new plugin, and show a whole-page refresh action. Keep protocol 1.0 plugins compatible. Increment affected plugin versions.
- No production deployment, real Mison booking/cancellation or unrelated scrolling/layout remediation.

## Tasks

- [x] Add isolated database integration tests in `tests/backend/test_mison_sync_integration.py` for disconnect/rebind/expired credentials, jobs, saved settings, retries, conflicts, concurrency and transaction rollback.
- [x] Run the new tests against guarded local `lele_test*` configurations and confirm the review failures.
- [x] Update `backend/lele_growth/plugins/private_bridge.py` and `login_sessions.py` for narrowly scoped job identity. Sign and preserve the job attempt across transport/admission and recheck the current lease.
- [x] Update `backend/lele_growth/course_sync_host.py` and plugin `backend/mison_booking/course_sync.py` for binding fences, saved settings and atomic save receipts. Use existing private-record tables; no schema migration is required.
- [x] Update plugin `frontend/api.ts` and `profile-and-account.tsx` to carry revisions/bindings, preserve uncertain request identity and reload current settings.
- [x] Add frontend-protocol contract/HTTP tests, update SDK and manifest validation, and pass advertised support through accounts app, gateway and plugin routes.
- [x] Update frontend loader/client/page handling and declarations. Add browser regression for protocol negotiation and save request retries/conflicts.
- [x] Run targeted Python regressions, all backend tests, affected TypeScript checks, plugin/host builds and existing affected browser workflows.
- [x] Review the final diff and record results and remaining review findings here.

## Validation commands

Use `LELE_TEST_CONFIG=data/testing/backend/config.json`, `LELE_TEST_DB_CONFIG=data/testing/backend/postgres-config.json`, `PYTHONPATH=backend` with `.venv/bin/python -m unittest`. The test configuration guards require development and localhost `lele_test*`; the integration fixture creates and drops its own database.

```sh
.venv/bin/python -m unittest tests.backend.test_mison_sync_integration tests.backend.test_plugin_frontend_protocol -v
npm run check:parent
npm run check:admin
npm run check:mison
npm run test:domain
npm run plugin:build -- mison-booking
node tests/browser/mison_frontend_acceptance.cjs
node tests/browser/plugin_parent_ui.cjs
git diff --check
```

Browser plugin is not available in this session; use the repository's existing Playwright fixture workflow. All Mison upstream interactions remain injected fixtures.

## Initial-phase results

- New integration tests first reproduced the selected failures; all 409 backend tests now pass. Final sync integration also passes with credential-revision changes, restricted job capabilities and invalid job attempts/leases.
- Parent, admin and Mison TypeScript checks and domain tests pass. Modified frontend files pass Prettier; typography, repository layout and `git diff --check` pass.
- Full Mison browser acceptance passes, including response loss with exact original retry, explicit revision conflict recovery, authoritative settings reread and sync disable.
- Plugin host browser acceptance passes, including frontend header negotiation, legacy 1.0 compatibility and refresh UI before loading incompatible code.
- Parent assets were rebuilt. Mison 1.0.30 and growth-notes 1.0.1 development packages build successfully with protocol 1.1 declarations.
- No production/local installation deployment or real Mison write was performed. At the end of this initial phase, generic-plugin scrolling, old admin assets and iPad-specific acceptance issues remained outside scope; the follow-up below addresses the newly selected items.

## Follow-up: review items 7, 8, 9, 10 and 12

**Approved scope:** The user selected these five items after the impact review. Implement them in this chat; keep the approved retained-mount lifecycle. This phase does not deploy or perform real upstream writes.

**Approach:** Rebuild admin assets from the current source and compare them with an independent build. Replace the iPad unmount assertion with retained-instance, hidden/inert, focus and scroll-lock checks. Diagnose the download failure and verify the downloaded bytes, rather than accepting an event or filename alone. Apply Prettier to the identified files. Align deployment/version/evidence documents with the owning code, preserving the distinction between fixtures, historical read-only evidence and unperformed production acceptance.

- [x] Item 9: Require `download.failure() === null`, save the PDF and compare its complete bytes with `pdfFixture()`; diagnose any failure before changing product code.
- [x] Item 8: Check retained page and overlay identity, hidden/inert state, absence from keyboard focus, released scroll lock, and restored state after returning. Run the existing plugin lifecycle acceptance for child switch, disable and uninstall.
- [x] Item 10: Format `frontend/parent/src/features/ui.tsx`, `plugins/mison-booking/frontend/courseware-picker.tsx` and modified browser tests. Run the repository format gate and the plugin format check.
- [x] Item 12: Update `docs/plugins/deployment.md` to plugin schema v3, migration ordering and frontend 1.1 compatibility; update the Mison README and current build example; reconcile `docs/plugins/mison-booking/upstream-verification.md`, `api-contract.md` and the handoff entry against current implementation and recorded evidence.
- [x] Item 7: Run `npm run build`, compare both generated surfaces with independent temporary builds, validate their resource graphs and create an explicitly marked local development release archive.
- [x] Run Chromium/WebKit iPad acceptance, plugin host lifecycle acceptance, relevant TypeScript/domain/layout/typography/format checks and `git diff --check`; record actual results and remaining release acceptance here.

Browser plugin is not available. Use the repository's Playwright fixtures and system temporary directories for browser evidence. No real Mison requests are part of this phase.

### Follow-up evidence and results

- Download diagnosis: Chromium's native anchor download bypassed Playwright request routing. A network trace captured the synthetic media URL with `filename` receiving Vite HTTP 404; preview fetches had been fulfilled successfully. A disposable comparison reproduced cancellation when only interception supplied the PDF, while an actual HTTP PDF response downloaded completely. No product download change was necessary.
- The Mison fixture now serves its synthetic PDF from Vite middleware with file length and inline/attachment headers. `PARENT_ACCEPTANCE_ORIGIN` proxies only the target's page/static assets through the local fixture origin; API/plugin requests never reach that target. Chromium and WebKit iPad suites now save and compare all 3,377 PDF bytes before cleanup.
- Chromium and WebKit iPad suites pass through download, screen rotation, last-page reading, canvas release, invalid-PDF retry, retained-instance navigation, settings/calendar scrolling and task-keyboard flows. Screenshot/JSON evidence is under `/private/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-WguUCe` (Chromium) and `mison-frontend-UJJn9X` (WebKit). No page exceptions; each source-development suite records the two pre-existing Radix/React `flushSync` warnings separately.
- Installed-build-path Chromium acceptance also passes against the rebuilt parent bundle, with zero API requests to its static target and zero console errors/warnings. Evidence: `/private/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-nQ3KCk`; log `/tmp/lele-followup-built-ipad.log`.
- Plugin-host lifecycle acceptance passes, including retained page instances, child-switch abort/disposal, disable, uninstall, update, protocol negotiation and stale-context isolation. Log: `/tmp/lele-followup-plugin-lifecycle.log`.
- Full core browser regression passes against the rebuilt host assets: 56 scenarios, 138 accessibility checks with zero violations, and zero page exceptions. This includes admin search/status/reset/profile/mobile behavior, parent task/points flows, retries, stale responses, printing and responsive PC/iPad layouts. Log: `/tmp/lele-followup-core-browser.log`; results and screenshots: `/Users/xiaobin/Desktop/项目/乐乐成长/output/playwright/shadcn-unified/result.json`.
- `npm run build` passes both TypeScript checks and regenerates admin `index-Cu8_0nS0.js` / `index-BGrutGSC.css` and parent `index-CFElBt6u.js`. Independent temporary builds match every byte of all 5 admin and 9 parent files. Build logs: `/tmp/lele-followup-host-build.log`, `/tmp/lele-followup-admin-repro.log`, `/tmp/lele-followup-parent-repro.log`.
- All 14 release/package validation tests pass, including complete resource graphs, archive hashes, unpacked static serving and rejection of incomplete/stale manifests. Log: `/tmp/lele-followup-release-tests.log`. The local host archive under `/tmp/lele-followup-release/` contains 91 verified files matching the workspace and is explicitly `purpose=development`, because changes remain uncommitted.
- Parent/shared/plugin Prettier checks, Mison TypeScript, domain regressions, typography/layout and `git diff --check` pass. All relative links in the six updated plugin documents resolve. The documents now distinguish current capability, historical evidence and outstanding acceptance.
- Still outside this selected scope: item 5 generic-plugin long-content clipping; production migration/rollback rehearsal; authorized real upstream booking/cancellation acceptance; physical iPad home-screen acceptance. No production deployment or actual Mison write was performed.
