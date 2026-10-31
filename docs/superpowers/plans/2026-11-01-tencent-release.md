# Tencent Plugin Release Implementation Plan

> Execute the user-authorized review, merge and deployment inline. Exclude the full `demo-page` and `demo-service` plugins from review, tests and release artifacts.

**Goal:** Review the current branch for the existing Tencent production environment, fix release blockers, then merge into main and publish to Tencent.

**Architecture:** Keep the existing RDS database and private OSS configuration. Add the explicit plugin v2 schema through the maintained CLI and run the isolated plugin runtime beside the two application services. Preserve the original business tables and rows, and keep the current Tencent release for compatible code rollback.

**Tech Stack:** Python 3.13.18, PostgreSQL 18.6, Linux systemd/Unix sockets, FastAPI, React/Vite, Nginx.

---

- [x] Review backend, frontend and deployment changes with emphasis on Linux, schema maintenance, private directories, SDK packaging and build/source consistency.
- [x] Run non-Demo backend tests, domain/type checks and fresh host builds; fix concrete blockers and commit their changes.
- [x] Verify the Tencent production migration on an isolated restore with original business rows preserved; validate Linux runtime and package imports.
- [x] Merge the verified branch into main, tag the actual deployment commit, generate the clean allowlisted package, and verify that no full Demo source/runtime code is included.
- [x] Take a consistent backup on Tencent, explicitly maintain the plugin schema, install matching application/runtime services, and switch the release atomically after health checks.
- [x] Check HTTPS, assets, authentication/Origin rejection, private paths, database/OSS reads, runtime health and data preservation. Record remaining provider HTTP/renewal restrictions separately.
- [x] Save release, rollback and verification evidence; report the deployed commit and service status. Do not stop the old Alibaba service as part of this task.

Relevant commands:

```sh
npm run check:parent
npm run check:admin
npm run test:domain
npm run build
git diff --check
.venv/bin/python scripts/package_release.py
```

Backend discovery explicitly excludes `tests/backend/test_demo_plugins.py`. Native backups, restore databases, credentials and raw business records stay in private server directories. Production business operations and OSS objects are not used as test fixtures. Tencent's existing HTTP provider interception and pending access filing remain a separate infrastructure acceptance item.
