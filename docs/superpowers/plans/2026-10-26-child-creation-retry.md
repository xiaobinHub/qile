# Child Creation Retry Implementation Plan

> **For agentic workers:** Execute the approved fix inline; preserve the feature branch and use isolated test databases.

**Goal:** A failed list refresh or lost create response must never duplicate one child creation attempt.

**Architecture:** Both creation forms share an attempt helper that retains the request ID and confirmed child ID. The server stores the creation request in the existing idempotency table in the same transaction as the child. One nullable field plus a unique index provides durable actor-scoped deduplication; existing data and structure record number remain unchanged.

**Tech Stack:** React/TypeScript, Python/FastAPI, PostgreSQL, unittest and Playwright.

- [x] Add backend regression coverage for retry, concurrent replay, conflicting parameters, actor isolation, rollback and revoked access.
- [x] Add `idempotency_records.creation_request_id` and its actor-scoped unique index through an independent table addition; integrate preview, fingerprints and release resources.
- [x] Require `requestId` on public child creation, serialize the same actor/request pair, and atomically create the child plus receipt; replay must check current child access.
- [x] Share request retention between settings and onboarding. Disable submitted fields after an uncertain result; cache confirmed child IDs and show “儿童已添加，列表刷新失败，请重试刷新。” with a refresh-only retry.
- [x] Verify old rows and table identity survive the additive script, with record number staying 6 and repeat maintenance doing nothing.
- [x] Exercise pre-commit failure, successful commit followed by failed GET, lost POST response, and simultaneous replay. Use only isolated test databases.
- [x] Run type/domain/backend/browser checks, rebuild tracked parent assets and inspect the final diff. No merge or deployment.

The human approved the two-layer design before implementation. Request IDs identify attempts, not child names; distinct requests may create children with the same name. Request state in the browser is temporary control state; the database receipt is authoritative. No production or development data changes are required to verify this fix.

Local development runtime was then updated for manual acceptance after a private native backup: `data/development/backups/before-child-creation-retry-20261026-083731.dump`. The adjacent `.verification.json` confirms all 24 original table row counts, row hashes, table OIDs, database identity and PostgreSQL version are unchanged (excluding the new nullable field). Record number remains 6. Parent/admin services on 18787/18788 restarted and their served asset hashes match this working tree. Production is untouched.

Browser plugin not available; validation uses the repository Playwright suite with real APIs against `lele_test_unified_ui`, ports 18887/18888. New retry checks cover both forms across all three failure modes, with desktop 1305×890 and narrow-screen 390×844 screenshots stored in the OS temporary directory. iPad checks in the broader suite are emulated, not physical-device verification.

Final validation: all 140 backend tests and 44 browser scenarios passed; 120 accessibility states have zero violations and zero page errors. Domain/runtime tests, parent TypeScript/build, formatting, layout, typography and source whitespace checks passed. The implementation was verified on `codex/child-management-ui`; subsequent commit and merge identities are recorded in Git.
