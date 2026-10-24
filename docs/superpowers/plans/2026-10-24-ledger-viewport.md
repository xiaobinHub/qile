# Ledger viewport fill and right-aligned adjustment

**Goal:** Separate manual adjustment at the right edge and extend the ledger to the bottom of the viewport without a gray footer gap.

**Architecture:** Give manual adjustment its own right-aligned grid column while keeping clear next to the filters. Scope a flex page layout to the active ledger, remove its bottom outer padding, and let the table consume remaining space with internal scrolling on desktop/tablet windows of at least 600px height. Preserve natural document scrolling on mobile and short windows. Switching to gifts/settings/calendar restores their existing layouts.

- [x] Separate the manual action and scope the ledger viewport/flex/table scrolling rules.
- [x] Verify toolbar edges, viewport bottom, table scroll/sticky header, sparse results, manual dialog, short-window fallback and tab restoration across wide desktop, tablet and mobile sizes. Inspect screenshots and confirm served development assets. No real-data writes or deployment.

Browser plugin not available; use the existing isolated Playwright harness, intercepted ledger fixtures and dedicated test database.

## Validation result

Parent build/typecheck, formatting, typography, repository layout and diff checks passed. Targeted browser layout acceptance passed ten windows: 1135×789, 1218×789, 1920×1028, 1218×480, 897×789, 820×1180, 768×1024, 700×1000, 1180×820 and 390×844. No page errors or violations across 12 accessibility states. Checks cover right-edge manual alignment, separation from left filters at wide widths, no overlapping controls (including after selecting a source), no gray bottom gap, exact table-to-viewport fill on desktop, internal scrolling/sticky headings, sparse results retaining the full-height white surface, manual dialog open/cancel and restoring the original gifts layout before returning to ledger. Inspected wide desktop, portrait tablet and mobile screenshots. A detected tablet overlap was fixed by reserving the manual button's intrinsic minimum width in its grid column. Short windows/mobile retain natural page scrolling; physical tablet Safari was not tested.

Read-only development health and JavaScript/CSS/font hashes confirmed port 18787 serves final assets. No real-data writes, backend/domain changes or production deployment occurred. Tests use intercepted fixtures and setup in the dedicated test database. The full unrelated regression suite was not repeated for this layout-only change.
