/* Repository boundaries: sources, test fixtures and deployable assets. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const root = path.resolve(__dirname, "..")
for (const folder of ["backend/lele_growth/db", "frontend/parent/src", "frontend/admin/src", "frontend/shared/src", "tests/backend", "tests/browser", "tests/domain", "tests/fixtures", "deploy", "config", "web/parent-dist", "web/admin-dist"]) {
  assert(fs.statSync(path.join(root, folder)).isDirectory(), `Missing directory: ${folder}`)
}
for (const old of ["parent-ui", "admin-ui", "shared-ui", "db", "accounts_app.py", "server.py", "index.html", "legacy", "data/lele-lan-access.json", "data/lele-task-manager.json", "data/rds-config.json", "data/rds-cutover.json", "data/storage-mode.json", "data/lele-operation-log.jsonl", "data/backups", "data/logs", "data/migration-baseline", "data/production-isolation"]) {
  assert(!fs.existsSync(path.join(root, old)), `Obsolete root entry: ${old}`)
}
const development = path.join(root, "data/development")
if (fs.existsSync(development)) {
  const misplaced = fs.readdirSync(development).filter(name => /^(?:browser-|unified-|ui-audit|shadcn-|oss-test|oss-migration|review-fixes-|layout-|before-|config\.before-)/.test(name))
  assert.deepEqual(misplaced, [], "Historical/test files do not belong in the live development directory")
}
assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith(".py")), ["dev.py"], "Only the compatibility dev entrypoint belongs at the root")
for (const app of ["parent", "admin"]) {
  const config = fs.readFileSync(path.join(root, `frontend/${app}/vite.config.mts`), "utf8")
  assert(config.includes("../shared/src"), `${app}: shared component alias`)
  assert(config.includes(`../../web/${app}-dist`), `${app}: build output`)
  assert(fs.existsSync(path.join(root, `web/${app}-dist/index.html`)), `${app}: built entrypoint`)
}
for (const name of fs.readdirSync(path.join(root, "backend/lele_growth")).filter(name => name.endsWith(".py"))) {
  const source = fs.readFileSync(path.join(root, "backend/lele_growth", name), "utf8")
  assert(!/^\s*(?:from legacy\b|import legacy\b)/m.test(source), `Current backend depends on legacy: ${name}`)
}
console.log("Repository layout passed: application, test and deployment boundaries; retired runtime artifacts absent.")
