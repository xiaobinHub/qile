# Category colors in selection

Add the configured category color as a small decorative dot before each category name in task and preset category selects. Use the existing Choice component with optional option colors; all other Choice fields retain text-only options. Preserve category labels, active/inactive filtering, keyboard search, selection and API values. The selected category also carries the dot through the existing SelectValue rendering.

The user's follow-up requires category panels to stay below their trigger. Add an opt-in downward Popper placement with flipping disabled, align to the input's start edge, and retain the shared available-height/scroll behavior. Other Choice fields keep their current placement.

- [x] Add optional option colors and decorative dot rendering to `features/ui.tsx`.
- [x] Pass actual category colors from task/preset editors in `features/calendar.tsx`.
- [x] Build and run focused isolated browser checks across desktop/iPad/narrow layouts: exact colors and order, mouse/keyboard selection, labels, unchanged API category IDs and both editor forms. Verify development assets. Do not write real development or production records.

Validation passed: parent typecheck/build, source formatting and diff checks; isolated browser acceptance at 897×789, 820×1180, 1180×820 and 390×844. Both task and preset menus rendered the exact configured colors before each label, stayed below the trigger and within the viewport, preserved labels/order/filtering, and accepted mouse/keyboard selection. Intercepted task/preset payloads retained the correct category IDs. All 6 accessibility states and page-error checks passed. Browser screenshots/results are in `/private/tmp/lele-category-qa`. Physical iPad Safari is outside this emulated coverage. No real development or production business writes occurred.
