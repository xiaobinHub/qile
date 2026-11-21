# Mison Bark Notifications Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent frontend work. Preserve all existing uncommitted changes and do not commit or deploy to production.

**Goal:** Remove the check interval hint and add optional multi-device Bark notifications for successful automatic bookings.

**Architecture:** Add `notifications: { enabled: false, barkKeys: [], events: ["booked"] }` to automatic booking config. The host validates it, encrypts keys with its existing credential vault, returns keys only to the owner, and creates a durable delivery entry when an automatic booking is confirmed. The plugin claims each delivery before a bounded POST to the fixed official Bark endpoint; notification results are recorded independently of booking results. Claims prevent duplicate sends after ambiguous transport outcomes.

**Tech Stack:** Existing React/Radix controls, Python plugin/host bridge, AES-GCM vault, urllib POST, unittest and isolated Playwright fixture host.

---

### Task 1: Frontend (delegated)

- [x] Remove the check interval description and its unused ARIA description links.
- [x] Add the notification config type, old-config defaults, dirty comparison, validation and save payload.
- [x] Add a “消息提醒” switch, password inputs for multiple Bark keys (add/remove), and the “约课成功” checkbox. Show inputs only when enabled. Default scene is booked. Require a key and scene when enabled, reject invalid/duplicate keys, and preserve typed drafts until save.
- [x] Keep members read-only; they receive placeholder key strings and should see only a configured key count.
- [x] Update the existing browser fixture config and accepted save fields. Run the Mison type check.

### Task 2: Host storage and delivery admission

- [x] Normalize older configs to disabled notifications, validate strict settings and preserve previous settings for legacy requests that omit the field.
- [x] Encrypt saved key lists using the existing vault scoped to plugin, child and account; keep plaintext out of private records, logs and job results.
- [x] Queue only confirmed successful automatic booking operations, including reconciled successes. Claim each delivery before network I/O and retain completed/ambiguous outcomes to prevent duplicate messages.
- [x] Keep delayed delivery eligible for recovery while task is stopped, subject to existing account/owner fences. Record notification status separately from the booking result.

### Task 3: Bark transport and verification

- [x] POST JSON to `https://api.day.app/push` with `device_key` for one recipient or `device_keys` for multiple recipients, Chinese title/body, group and ttl=600. Use no redirects, bounded response and timeout, and validate HTTP and Bark response codes.
- [x] Test persistence/encryption, owner-only key access, disabled/unselected scenes, direct and reconciled success, deduplication, stopped-task recovery and notification failure isolation using synthetic keys/transports.
- [x] Exercise switch, key add/remove, scene checkbox, invalid config, save/reload and responsive/read-only UI in the isolated Playwright harness. Do not send an unsolicited real test push.
- [x] Run type checks, targeted backend tests, plugin build and diff whitespace checks. Keep evidence outside the repo and verify local source development remains ready.
