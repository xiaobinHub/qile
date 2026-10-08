# Points Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable one-time gift catalog where points can be redeemed and reversals preserve immutable ledger history.

**Architecture:** Extend AppData with versioned gift records and reuse the existing full-document persistence transaction. Render the store as a fourth top-level view, use static dialogs for management and confirmation, and represent redemption/reversal as new ledger kinds.

**Tech Stack:** Single-file HTML/CSS/vanilla JavaScript, Python 3 standard-library JSON server, unittest.

---

### Task 1: Schema migration and validation

**Files:**
- Modify: `index.html`
- Modify: `server.py`
- Test: `test_server.py`

- [x] Introduce separate AppData and backup version constants, migrate schema 1 data to schema 2 with `gifts: []`, and validate gift fields and gift ledger kinds.
- [x] Raise the server request limit to 16 MiB and accept AppData schema version 2 while keeping the storage envelope at version 1.
- [x] Add tests proving schema 2 writes succeed and unsupported schemas are rejected.

### Task 2: Store navigation and gift presentation

**Files:**
- Modify: `index.html`

- [x] Add the “积分商城” navigation item and route it through `render()`.
- [x] Render available and redeemed gift sections with current balance, insufficient-points state, empty state, and responsive cards.
- [x] Keep the top-level balance synchronized after redemption and reversal.

### Task 3: Gift management and image compression

**Files:**
- Modify: `index.html`

- [x] Add static management and editor dialogs with name, integer points, optional image, preview, edit, and delete controls.
- [x] Decode selected JPEG/PNG/WebP images, resize to at most 640px, encode WebP/JPEG, and iteratively reduce quality/dimensions until the binary payload is at most 180 KiB.
- [x] Persist only after validation, roll back on storage errors, and require confirmation before deletion.

### Task 4: Redemption transaction and reversal

**Files:**
- Modify: `index.html`

- [x] Add a confirmation dialog showing current balance, cost, and remaining balance.
- [x] On redemption, atomically mark the gift redeemed and append a negative `gift-redeem` ledger entry with a name/points snapshot.
- [x] On reversal, append a positive `gift-reversal` entry linked to the redemption and return the gift to available state.
- [x] Disable repeated submissions and preserve the current page on version conflicts.

### Task 5: Ledger integration and regression tests

**Files:**
- Modify: `index.html`
- Test: `test_server.py`

- [x] Add “礼品兑换” to the ledger source filter and label redemption/reversal rows explicitly.
- [x] Add hidden self-tests for migration, redemption, insufficient points, duplicate redemption prevention, reversal, and immutable snapshots.
- [x] Run `python3 -m unittest -v test_server.py`, JavaScript syntax validation, hidden self-tests, and whitespace checks.
