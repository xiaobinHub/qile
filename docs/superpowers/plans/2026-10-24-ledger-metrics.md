# Filtered ledger metrics and compact filters

**Goal:** Rename earned/deducted metrics, count final task earnings and genuine deductions, offer action-level filters, and reduce the filter area's visual size.

**Semantics:** Resolve task completion/reversal pairs over the full chronological ledger before filtering. Only uncancelled completion amounts whose records match the selected date/source/action contribute to earned points. Manual increases and gift refunds are not task earnings. Deducted points sum matching manual negatives and gift redemption negatives; task reversals are excluded. Current balance and historical balance-after values continue to use the whole ledger. Keep gift reversal visible as an additional action filter.

- [x] Extract pure ledger classification, filtering and aggregation; verify cancellation, repeat completion, cross-date reversals, action/source/date filters and historical balances.
- [x] Update metrics and scene labels, remove gray filter background, constrain controls without reducing touch targets, and retain narrow-screen layout.
- [x] Build and run isolated browser acceptance at desktop, iPad and mobile sizes; exercise every scene, date/source filtering and reset, check accessibility and inspect screenshots. Run the existing regression suite and confirm development assets; no production or real-data writes.

Browser plugin not available; use the existing Playwright test harness and its dedicated test database.

## Validation result

Parent build/typecheck, domain/runtime tests (including final ledger earnings, same-time/cross-date reversal, re-completion, all six scenes, source/date intersections and preserved historical balances), formatting, typography, repository layout and diff checks passed. Full isolated browser regression passed 34 scenarios with no page errors and zero violations across 54 accessibility states. After a final CSS-only refinement at the 760px wrapping boundary, targeted acceptance passed at 1135×789, 897×789, 820×1180, 768×1024, 700×1000, 1180×820 and 390×844 with no page errors and zero violations across 16 accessibility states. Inspected desktop, portrait tablet and mobile screenshots; controls remain 44px high on touch devices. Scenarios exercise all scenes, keyboard selection, focus containment, date/source/action intersections, empty results and clear filters. Long ledger tables now have a keyboard focus target for scrolling. Open Radix listboxes are scanned directly, with separate explicit checks that background focus attempts and Tab/Shift+Tab remain trapped; this avoids axe's dialog-only background modal heuristic. No rules are disabled.

Read-only health and hashes confirmed development port 18787 serves all final JavaScript, CSS and font assets. Browser fixture ledger records exist only in intercepted test responses; test setup uses the dedicated test database. No backend/schema changes, production deployment or real-data writes were made. Physical iPad Safari was not tested.
