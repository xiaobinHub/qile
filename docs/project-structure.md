# 项目目录规范

## 约定

1. 根目录只放项目说明、依赖清单、工具配置及兼容开发入口。业务 Python 代码只在 `backend/lele_growth/`，统一通过 `lele_growth.*` 导入。
2. 两个前端使用独立 Vite 入口，共用 `frontend/shared/`，使用根目录同一份 `package.json` 和锁文件。不引入 npm workspace 或其他工作区工具。公共 TypeScript 编译规则在 `frontend/tsconfig.base.json`，两个入口互不继承配置。第三方分发许可集中在 `licenses/`。
3. SQL 是 `lele_growth` 包内资源，通过模块位置定位，不依赖启动时工作目录。静态文件从仓库发布根目录的 `web/` 读取，仅允许构建资源路由访问。
4. `tests/` 不包含正式数据；测试夹具不能成为生产服务运行依赖。浏览器测试的临时进程使用隔离数据库和端口。
5. `config/` 和 `deploy/` 只放示例，实际配置放本地被忽略的 `data/development/` 或云端 `/etc/lele-growth/`，权限为 0600。不要把云端凭据复制到源码目录。
6. `output/` 为可再生检查及打包结果，全部忽略。需要长期保存的已脱敏验收资料放在 `docs/`。
7. `legacy/` 是历史入口及兼容测试的对照材料，发布包不包含该目录；当前后端不得导入旧版服务。本地生产控制脚本和启动器已删除，历史说明移入 docs/archive/local-production/。
8. `web/` 继续纳入 Git，生产运行无需 Node.js。每次修改前端后必须重建并验证，不能把新 HTML 与旧分块混用。

## 路径映射

| 整理前 | 整理后 |
| --- | --- |
| `accounts_app.py` 等后端模块 | `backend/lele_growth/`，以 `lele_growth.accounts_app` 等包名导入 |
| `db/` | `backend/lele_growth/db/` |
| `parent-ui/` | `frontend/parent/` |
| `admin-ui/` | `frontend/admin/` |
| `shared-ui/` | `frontend/shared/` |
| 根目录 `test_*.py` | `tests/backend/` |
| `scripts/*_tests.cjs` | `tests/domain/` |
| `scripts/*smoke.cjs`、UI 验收脚本 | `tests/browser/` |
| `scripts/fixtures/` | `tests/fixtures/` |
| `dev.py` 实现 | `scripts/dev.py`；根入口仅转发 |
| `server.py`、`index.html`、`migrate_to_rds.py` | `legacy/` |
| `scripts/local_production.py` | 已删除，本地不再运行生产环境 |
| 旧生产 `.app` 和启动命令 | 已删除，本地仅开发测试 |
| `docs/rds/` | `docs/archive/rds/`，旧单孩子版本资料 |
| `deploy/production.example.json` | `config/production.example.json` |

早期设计、审查及验收记录中的路径描述保留当时事实；实际操作使用本表和 README 中的新命令。

## 常用命令

```sh
.venv/bin/python scripts/dev.py start
.venv/bin/python scripts/dev.py stop
.venv/bin/python scripts/dev.py test
PYTHONPATH=backend .venv/bin/python -m lele_growth.child_service --help
PYTHONPATH=backend .venv/bin/python -m lele_growth.media_migration --help
```

`python deploy/run.py` 可从任意工作目录运行，先定位发布根目录再加载应用包；前后端资源都从模块路径定位。开发命令保留旧 `python dev.py ...` 兼容入口。云端配置路径仍须显式提供，不能复制本地开发配置作为生产配置。
