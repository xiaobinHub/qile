# 商城两栏页签布局 Implementation Plan

**Goal:** Implement the user-approved two-tab store layout, with gift management in gift redemption and manual adjustments inside the ledger.

**Architecture:** Retain StorePage and the shared Radix Vega Tabs. Render available gifts and an initially collapsed redeemed-record list in the gift tab; pass the existing manual-adjustment callback and read-only state into LedgerPanel. All commands, calculations and confirmation behavior remain unchanged.

**Tech Stack:** React, TypeScript, existing shadcn/ui Tabs/Button/Badge/Card, Vite, Playwright.

Baseline: `03b9db1`. Local only; preserve the untracked user API document. No database or API changes.

- [x] Update `parent-ui/src/features/store.tsx`: two tabs (礼品兑换 / 积分流水); move actions to their sections; compact history with image/name/points/date/reversal; preserve default collapse and accessible keyboard toggle.
- [x] Update `parent-ui/src/styles.css`: scoped line-style tabs, section headers, 280–300px gift cards, history rows and iPad wrapping; no shared theme changes.
- [x] Adapt `scripts/unified_browser_smoke.cjs` and `scripts/pc_ipad_ui_acceptance.cjs` to the new entry points; verify the two-tab structure, keyboard expansion, live redemption/reversal, ledger-only adjustment and archived restrictions.
- [x] Run parent typecheck, format check, parent build and existing isolated browser regression. Inspect desktop/iPad and narrow screenshots. Browser plugin is absent, so use repository Playwright. No writes to development or production data.
- [x] Confirm development fingerprint unchanged, save code/build rollback commit and provide local preview.

Validation: parent typecheck/build/format passed; 23 browser scenario groups passed including all seven PC/iPad sizes; 17 axe scans with zero violations and zero page errors. Read-only screenshot inspection covered 1305×984, 820×1180 and 390×844. Browser plugin unavailable; repository Playwright used. Development fingerprint remains 15 tables / 594 rows / SHA-256 0540e917de031a1c85224d524aac684009d078480472f22b4a2220f43b2c8dfd. Test writes used disposable test databases only. Production and physical iPad were not modified or tested.

## Follow-up: gift editor and management polish

- [x] Remove the repeated in-page store title, retaining the main navigation label.
- [x] Bound the image upload preview to 184px with contained, absolutely positioned images; use the preview button for upload/replacement, retain removal and type/size validation, remove the separate upload button.
- [x] Simplify the gift manager with thumbnails, compact metadata/status and edit/delete actions. Keep all command payloads and permissions unchanged.
- [x] Remove reserved title height so cost follows the title, while keeping card actions aligned.
- [x] Extend isolated browser regression with a 2100×3200 image, keyboard file chooser, remove/replacement and existing-image editing. Check geometry at 1298×984, 820×1180, 1180×820 and 390×844. 23 scenario groups and 19 axe scans passed with zero page errors/violations.

The user has added business records since the preceding layout change. This follow-up baseline is 15 tables / 620 rows / SHA-256 1870275febb72789d59006bd05d7b8d86378f092cc569a70526100ba10dec8aa; compare only against this new baseline, not the historical 594-row snapshot above. No production deployment.

Final comparison during this follow-up: development rose from 620 to 624 rows, with one additional task series/revision, business operation and snapshot; metadata and an existing exception also changed. The gifts table fingerprint stayed identical. This is a live development environment, so the complete fingerprint is not claimed unchanged. All automated write tests target lele_test_unified_ui; the read-only audit fixture remained unchanged.
