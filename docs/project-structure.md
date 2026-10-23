# 当前项目目录规范

| 目录 | 现用职责 |
| --- | --- |
| `backend/lele_growth/` | FastAPI、业务、事务、存储、媒体及 SQL |
| `frontend/parent/`、`frontend/admin/` | 两个 Vite 应用 |
| `frontend/shared/` | 共享 shadcn/ui 组件及主题 |
| `tests/backend/`、`tests/browser/`、`tests/domain/` | 当前后端、浏览器及领域回归 |
| `tests/fixtures/` | 回归实际引用的规则对照及视觉样例 |
| `scripts/` | 开发、检查、打包工具 |
| `deploy/`、`config/` | Linux 入口、部署模板和无密钥示例 |
| `web/`、`licenses/` | 已构建资源及第三方许可 |
| `docs/` | 当前操作、组件及验证说明 |
| `data/development/` | 现用开发数据库、配置、凭据和活跃运行文件 |
| `data/testing/` | 可再生的隔离测试配置、日志和测试对象 |

## 边界

- Python 统一通过 `lele_growth.*` 导入；SQL 从包位置定位，公开静态文件仅来自 `web/`。
- 前端共用根 npm 清单/锁文件和 `frontend/tsconfig.base.json`，通用控件只从共享目录组合。
- `.git/`、`.venv/`、`node_modules/` 和开发数据库是现用版本管理或开发依赖，不是废弃文件。配置、依赖、测试产物、构建缓存不进入发布包。
- 历史配置副本、迁移原始留档、测试对象和审查摘要不再混入 `data/development/`。测试运行使用 `data/testing/`，可再生检查结果使用 `output/`。
- 旧服务入口、局域网口令功能、本地生产工具、旧数据及历史文档已移到项目外私有归档。当前代码和测试不依赖 `legacy/`。
- `tests/fixtures/calendar-legacy.cjs` 仍用于当前 33 组算法等值验证；共享存储模块及 SQL 基线仍用于当前校验、升级或回归，所以保留。
- 根 `dev.py` 为受支持的兼容入口；本地测试快捷方式调用 `scripts/dev.py`，生产运行入口为 `deploy/run.py`，显式离线维护入口为 `deploy/manage.py`，两者职责分离。
- 两端 `web/*-dist/.vite/manifest.json` 是发布资源依赖校验的输入，随构建和发布保存，不对外公开；正式包要求源码及构建结果已提交，开发验收包必须显式加 `--allow-dirty`。

操作见 [本地开发](development.md)、[部署说明](../deploy/README.md) 和 [OSS 说明](oss-storage.md)；移出项目的数量及恢复位置见 [清理记录](local-cleanup-2026-10-23.md)。
