# 成长计划

家长与孩子共同管理任务、积分和礼品的 Web 应用，包含独立管理后台。

技术栈：Python 3.13 / FastAPI / PostgreSQL、React / TypeScript / Vite、Tailwind CSS / shadcn/ui，图片使用私有阿里云 OSS。

## 项目结构

```text
backend/lele_growth/  后端 Python 包、API、业务逻辑、存储及 SQL
frontend/parent/     家长端应用
frontend/admin/      管理后台应用
frontend/shared/     共享 shadcn/ui 组件、主题和字体规范
tests/backend/       Python 单元及隔离数据库回归
tests/browser/       浏览器、可访问性及 PC/iPad 模拟回归
tests/domain/        日期、规则、积分、打印及请求状态回归
tests/fixtures/      只读测试样例
scripts/             开发启动、检查及发布包生成工具
deploy/              Linux 运行入口、systemd 与 Nginx 模板
config/              不含真实凭据的配置示例
web/                 两端已构建的静态文件，纳入版本
docs/                开发、部署、设计及验收记录
licenses/            随应用分发的第三方组件及字体许可
legacy/              旧版程序，仅历史对照，不参与新服务发布
data/                私有本地运行文件，被 Git 和发布包排除
```

详细边界和旧路径映射见 [目录规范](docs/project-structure.md)。

## 本地开发

需要 Python 3.13、Node.js 22.12+ 和本地 PostgreSQL 16。以下命令在仓库根目录执行：

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e .
npm ci
npm run build
.venv/bin/python scripts/dev.py setup
.venv/bin/python scripts/dev.py start
```

也支持在虚拟环境中运行 `python -m pip install -e .`。开发服务为家长端 <http://127.0.0.1:18787> 和管理端 <http://127.0.0.1:18788>。本地数据库、初始账号和日志继续位于 `data/development/`；真实配置及密码不纳入版本。根目录 `dev.py` 和本地测试快捷方式保留兼容。

启动器只初始化和操作本地开发环境，不可作为云端部署命令。详见 [本地开发说明](docs/development.md)。

## 检查与测试

```sh
npm run check:layout
npm run check:typography
npm run test:domain
npm run build
.venv/bin/python scripts/dev.py test
npm run test:browser
```

后端及浏览器写入回归仅使用本机 `lele_test*` 隔离数据库；浏览器临时端口为 18887/18888。不设置测试数据库时，可运行 `PYTHONPATH=backend .venv/bin/python -m unittest discover -s tests/backend -t . -v`，数据库测试会跳过，不能将跳过结果当成完整验收。

## 云服务器部署准备

```sh
npm run build
.venv/bin/python scripts/package_release.py
```

发布包位于 `output/releases/`，只收录当前后端、SQL、构建产物、依赖清单、第三方许可及部署模板，排除本地数据、密钥、测试输出和旧版入口。打包不等于发布。

云端启动入口为 `deploy/run.py`，配置由 `LELE_ACCOUNTS_CONFIG` 显式指定。运行阶段不自动建库、迁移或初始化账号。数据库版本和存量图片迁移须另行核对、备份及演练。

见 [部署说明](deploy/README.md)、[配置示例](config/README.md) 和 [OSS 说明](docs/oss-storage.md)。本次整理没有执行服务器发布，也未操作独立旧生产目录；本地生产启动工具已从当前仓库删除。
