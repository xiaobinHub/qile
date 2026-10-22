# 上云前目录整理验收

日期：2026-10-23。整理基线：`e3ed8a9`。环境定位为本地开发测试、阿里云生产；本次未执行云端发布、生产数据库操作或独立旧生产进程管理。

## 已完成

- 后端收敛为 `backend/lele_growth/` 可安装 Python 包；统一包导入与 mock 路径。SQL 迁入包内 `db/`，结构和文件内容未变。
- 前端迁入 `frontend/parent/`、`frontend/admin/`、`frontend/shared/`；公共 TypeScript 配置独立，家长端不再继承后台配置。两个 Vite 输出仍为 `web/`，公开资源地址不变。
- 测试归入 `tests/backend/`、`tests/browser/`、`tests/domain/` 和 `tests/fixtures/`；开发工具在 `scripts/`，根 `dev.py` 保留兼容入口。
- 按补充要求删除本地生产启动/停止 `.app`、命令、控制脚本及其专用测试。旧运行说明移入 `docs/archive/local-production/` 并标注停用；本地开发测试快捷方式保留。
- `legacy/` 仅保留旧服务、旧页面及 RDS 迁移对照代码，不进入发布包。
- 配置示例集中在 `config/`；新增 README、目录规范、部署说明、发布包工具及第三方 `licenses/`。
- `data/` 私有配置和数据库不移动；`output/`、构建缓存、Python 包元信息均忽略；无关的用户文档不纳入版本。

## 检查结果

| 项目 | 结果 |
| --- | --- |
| 原有后端回归 | 106 项通过；删除的本地生产控制器专用测试不再运行 |
| 新增目录/发布包回归 | 3 项通过，覆盖不同工作目录、私有路径隔离、归档内容与摘要、解压后入口拒绝缺失生产配置 |
| 领域与请求状态 | 33 组旧行为对比及运行时保护通过 |
| 前后端构建 | 两端 TypeScript 检查与 Vite 构建通过；`web/` 内容与基线一致 |
| 浏览器回归 | 28 组通过，页面异常 0，使用 `lele_test_unified_ui` 与 18887/18888 |
| 可访问性 | 27 个状态，违规 0 |
| 组件字体/格式/目录 | 检查通过 |
| Python 标准发行包 | wheel 构建通过，包含全部 4 份 SQL，未包含私有数据或旧服务 |
| 开发数据 | 24 张表、1097 条记录，整理前后逐表数量及 SHA-256 全部一致 |
| 开发服务 | 18787/18788 已恢复，进程使用 `lele_growth.accounts_app` |

原先 111 项后端测试中的 5 项仅针对已删除的本地生产控制器；现有 106 项加新增 3 项，共 109 项。普通构建仍提示已有较大分块，这是原有性能提示，本次静态产物没有变化。

## 证据位置

- `/tmp/lele-layout-backend.log`：106 项原有后端结果。
- 新增检查命令：`PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_project_layout -v`。
- `/tmp/lele-layout-browser.log` 及 `output/playwright/shadcn-unified/`：浏览器与可访问性结果。
- `/tmp/lele-layout-build.log`、`/tmp/lele-layout-domain.log`、`/tmp/lele-layout-format.log`、`/tmp/lele-layout-package.log`：构建、领域、格式和发行包结果。
- `data/development/layout-20261023/before.json`、`after.json`：私有开发库逐表摘要，不进入 Git 或发布包。
- `output/releases/`：允许清单生成的发布包和 SHA-256；包内有逐文件 `release-manifest.json`。

## 使用边界

目录整理不等于阿里云上线。云端域名、证书、Nginx/systemd 安装、生产数据库版本/迁移、对象存储及最终切换仍须在后续发布中分别核验。浏览器使用 Chromium 和 iPad 模拟，不替代真实 iPad 系统键盘和打印验收。

详见 [目录规范](project-structure.md)、[根目录说明](../README.md) 和 [部署说明](../deploy/README.md)。
