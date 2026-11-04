# Plugin development mode implementation plan

**Goal:** Edit existing plugin source in the real local host without republishing.

**Architecture:** A development-only session selects Vite assets and optionally a source worker. Installed releases and authorization remain authoritative. Source reload drains requests; it never retries business writes.

**Tech Stack:** Vite, React Refresh, FastAPI, Python worker supervisor.

## Tasks

- [x] Add development session registry, authenticated same-origin HTTP/WebSocket resource proxy, request session fencing, and private runtime controls. Production must reject development sessions. Validate installed manifest compatibility.
- [x] Add isolated source worker environment and non-destructive drain/reload/stop. Preserve installed artifacts, vault and operation records. Test draining and failed reload.
- [x] Add `npm run plugin:dev -- ID [--with-backend]`, shared build configuration and development CSS scoping. Bootstrap React Refresh and clean up mounts.
- [x] Integrate host loader with development descriptor and session fencing; keep normal release loading unchanged.
- [x] Verify typechecks, isolated backend tests and actual browser HMR against fixtures. No real upstream mutations. Document startup, shutdown and failure recovery.

## Acceptance

Source edits update the plugin without deployment. Styles remain scoped. Developer sees frontend/backend sources. Old sessions cannot write after switching. Reload never kills active requests solely because a file changed. Explicit stop restores installed mode; crashed services stay visibly unavailable until explicit recovery. Automated tests use synthetic upstreams; any real booking test must exceed 48 hours from submission.

## Verification evidence

- Parent build and plugin typecheck passed; typography/layout checks passed.
- Backend runtime/development suite: 48 tests, 47 passed and 1 existing environment-dependent skip.
- Full Mison browser acceptance passed in built and Vite source modes; real component/CSS saves preserved input and made no automatic writes.
- FastAPI + Vite + built host integration passed CSP, authenticated HTTP/WebSocket, deny paths, real HMR, style cleanup, reload recovery and session teardown.
- Development tool changes require no plugin version bump or publication.
- Actual local frontend-only and source-backend commands both registered, reloaded to revision 2, and stopped successfully. Installed release and credential ciphertext fingerprints stayed unchanged; zero business calls. Local services restarted once to load tooling, and no development overlay remains active.
