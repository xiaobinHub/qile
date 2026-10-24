# Linked ledger scene selection

**Goal:** Filter scene choices by the selected source, support multiple scenes, and use the requested ordering.

**Architecture:** Keep source selection single. Add source metadata to the ordered scene definitions; filter available scenes and retain only compatible selections when changing source. An empty scene selection means all scenes for that source. Reuse the existing Radix checkbox dropdown, keep it open while toggling choices, display one label or a compact selected count, and retain the current compact responsive layout. Combine selected scenes with OR, then intersect with date/source filters. Preserve the final-earnings calculation.

- [x] Extend domain filtering and tests for scene unions, source intersections, ordered options, compatible selection retention and all-scenes fallback.
- [x] Replace the scene single-select with the existing checkbox dropdown, wire source changes, and retain keyboard/touch targets.
- [x] Update isolated browser acceptance to cover mouse, keyboard, touch, source transitions, multi-selection, all/reset and metrics at the existing responsive sizes. Run build and relevant regression checks; verify development assets without writing real data.

Browser plugin not available; use the existing Playwright harness and its isolated test database. No deployment or backend changes are needed.

## Validation result

Parent build/typecheck, all domain/runtime tests, formatting, typography, repository layout and diff checks passed. Updated ledger acceptance passed at 1135×789, 897×789, 820×1180, 768×1024, 700×1000, 1180×820 and 390×844 with no page errors and zero violations across 16 accessibility states. Tests cover all scene labels and requested ordering, source-specific options, keyboard Space and pointer selection, keeping the menu open while toggling, clearing the final selected item back to all, retaining compatible choices across source changes, dropping incompatible choices, cross-source unions, date intersections, final earning/deduction metrics and clear/reset. Dropdown focus containment and Escape focus return passed. Inspected desktop and mobile multi-selection screenshots. Browser helpers wait for the closed menu to unmount before reopening so exit animations cannot leave stale locators.

Read-only health and JavaScript/CSS/font hash checks confirmed development port 18787 serves the final build. Fixtures remain in intercepted responses and the isolated test database. No real-data writes or production deployment occurred. Physical iPad Safari was not tested. The full unrelated 34-scenario browser suite was not repeated for this scoped follow-up; the seven-size ledger acceptance and all domain/runtime checks were rerun.
