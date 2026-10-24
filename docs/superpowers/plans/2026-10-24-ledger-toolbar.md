# Ledger toolbar above metrics

**Goal:** Put filters above the metric cards, remove the visible overview title, and place manual adjustment beside the filters.

**Architecture:** Move the existing filter group before the unchanged metric cards, group clear/manual actions in the last toolbar column, and give the ledger section an accessible name without a visible heading. Keep all controls in one row above 760px; below that, wrap the date and selects while keeping the two actions together.

- [x] Reorder the existing controls/cards, remove the overview heading, and fit the manual action into the compact responsive grid.
- [x] Build and verify the existing ledger acceptance at desktop, tablet and mobile sizes, including ordering, geometry, filtering and opening/cancelling manual adjustment. Check accessibility and development assets; no real-data writes.

Browser plugin not available; use the existing isolated Playwright harness. No domain/backend changes or production deployment are needed.

## Validation result

Parent build/typecheck, formatting, typography, repository layout and diff checks passed. Existing ledger browser acceptance passed at 1135×789, 897×789, 820×1180, 768×1024, 700×1000, 1180×820 and 390×844 with zero page errors and zero violations across 16 accessibility states. Added checks confirm the filters precede the metric cards, the visible overview heading is absent, all five desktop controls share one aligned row, and manual adjustment opens/cancels successfully without changing records. Existing multi-select, source/date filtering, metrics, keyboard and clear/reset scenarios also passed. Inspected desktop, 768px tablet and mobile screenshots. Below 760px the two action buttons remain together below the selects; all touch controls remain at least 44px high.

Read-only development health and JavaScript/CSS/font hashes confirmed port 18787 serves the final assets. All writes were limited to test setup in the dedicated test database; fixture ledger records were intercepted responses. No real-data writes, domain/backend changes or production deployment occurred. Physical tablet Safari was not tested.
