# Empty preset shortcut

Change the empty task-title suggestions to “暂无常用任务，去添加。” Selecting the action opens the existing add-preset form with Settings → 常用任务配置 behind it. Reuse the existing editor/save flow and keep the non-matching search message unchanged. Do not create a task while navigating. Support pointer and combobox Arrow/Enter selection; cancel returns focus to the settings add button.

- [x] Add a create-preset callback to `features/task-title.tsx` and `TaskEditor`; render the empty action as a selectable command option.
- [x] Route the callback through `App.tsx` to settings and the existing preset editor. Give SettingsPage an optional initial pane; reset this entry preference for normal navigation and child/context changes.
- [x] Validate click/keyboard navigation, correct settings pane, cancel focus, existing search behavior and the preset-save operation in isolated browser contexts. Build and run appropriate regressions; verify development assets.

Validation: parent typecheck/build, domain/runtime tests, formatting, typography and layout checks passed. The full isolated browser suite passed 32 scenarios with no page errors; all 42 accessibility states had zero violations. The new shortcut was verified by pointer and Arrow/Enter at desktop, iPad portrait/landscape emulation and 390px touch size. Correct settings-pane selection, cancel focus, no task operation during navigation, an isolated in-memory preset-save response, reuse of the newly added preset, unchanged non-matching search copy, and the existing normal settings landing pane all passed. Read-only development health and asset hashes confirmed port 18787 serves the final build. No production deployment or real business data writes occurred. Physical iPad Safari was not tested.
