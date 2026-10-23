# 本地开发与隔离测试

本地仅运行开发和测试，生产目标为阿里云。当前应用使用多孩子 v4 结构、账号登录及私有 OSS 图片，不使用旧 JSON 数据文件、局域网口令或旧 RDS 默认配置。

## 安装与入口

需要 Python 3.13、Node.js 22.12+、PostgreSQL 16；在仓库根目录执行：

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e .
npm ci
npm run build
.venv/bin/python scripts/dev.py setup
.venv/bin/python scripts/dev.py start
```

也支持在虚拟环境中执行 `python -m pip install -e .`。`setup` 只初始化本地开发环境，保留已有账号和数据。家长端为 <http://127.0.0.1:18787>，管理端为 <http://127.0.0.1:18788>，PostgreSQL 为 `127.0.0.1:55432`，开发库为 `lele_dev`。

初始账号资料在 `data/development/accounts.json`，初始登录名为 `admin` 和 `lele`，密码不在文档或 Git 中。改密后文件中的初始密码可能已经失效。根目录本地测试快捷方式和 `dev.py` 兼容入口保留；启动器显式定位当前后端源码。

```sh
.venv/bin/python scripts/dev.py status
.venv/bin/python scripts/dev.py stop
.venv/bin/python scripts/dev.py reset-admin --login-name admin
```

密码重置采用交互输入，不写入命令参数，并撤销旧管理员会话。

## 私有运行目录

```text
data/development/
  config.json           现用数据库、来源及 OSS 配置
  oss-credentials.json  现用 OSS 凭据
  accounts.json         初始化资料
  pg-password           初始化 PostgreSQL 用的本地密码文件
  pgdata/               PostgreSQL 集群，禁止手工清理
  parent.log/admin.log  当前 Web 日志
  parent.pid/admin.pid  当前 Web 进程标识
  postgres.log          当前数据库日志
  .s.PGSQL.55432*       活跃套接字和锁，禁止移动
data/testing/backend/   后端隔离测试配置和对象目录
data/testing/browser/   浏览器隔离测试配置、日志和对象目录
```

配置及凭据权限为 0600，运行目录为 0700，均排除在 Git 和发布包之外。开发配置只接受回环数据库地址及 `lele_dev` / `lele_test*` 库名，不读取生产默认配置。

旧局域网口令、JSON 业务文件及备份、旧 RDS 配置、迁移留档和历史测试产物已移出项目，见 [清理记录](local-cleanup-2026-10-23.md)。当前程序不会读取这些归档。

## 端口转发

外部域名、隧道或映射端口需在私有配置中分别授权来源，否则写请求提示“请求来源不受信任”：

```json
{
  "parent_trusted_origins": ["http://chenxiaobin.cn:18787"],
  "admin_trusted_origins": []
}
```

保留数据库、`parent_origin`、`admin_origin` 和 OSS 字段。来源是协议、主机和端口，不包含路径或通配符；两端分别授权。本机回环与同端口局域网访问继续可用，但不再依赖旧局域网口令文件。

改配置后重启开发 Web 服务。此配置不会取消登录、CSRF、角色或成员检查，不信任客户端自行提供的代理头。附加来源只允许 development；生产使用独立 HTTPS 来源。

## 构建与回归

家长端、管理端及共享组件分别位于 `frontend/parent/`、`frontend/admin/`、`frontend/shared/`。构建产物为 `web/parent-dist/` 和 `web/admin-dist/`，纳入 Git；服务不公开源码、配置或 source map。

```sh
npm run check:layout
npm run check:typography
npm run test:domain
npm run build
npm run check:format
.venv/bin/python scripts/dev.py test
npm run test:browser
```

后端配置自动生成于 `data/testing/backend/`，仅使用明确的本机 `lele_test*` 库。浏览器回归使用 `lele_test_unified_ui`、18887/18888 及 `data/testing/browser/`，不混入真实开发数据。截图结果位于可再生的 `output/playwright/`；首次回归需运行 `npx playwright install chromium`。

不要同时构建和执行浏览器回归，避免旧页面请求已替换分块。未提供测试数据库的 `PYTHONPATH=backend .venv/bin/python -m unittest discover -s tests/backend -t . -v` 会跳过数据库测试，不能当作完整验收。

## 数据与云端边界

业务修改继续通过明确操作接口，保留修订号、成员版本、操作编号和内部历史快照。真实开发业务保存在现用数据库和 OSS 中；家长端没有 JSON 备份导入/导出。

SQL 基线及版本升级位于 `backend/lele_growth/db/`。不要因文件名带旧版本就删除仍用于升级或共享存储回归的 SQL。未知数据库结构会停止初始化。

云端运行采用 [部署入口](../deploy/README.md) 和服务器独立配置，不自动建库、升级或初始化账号。生产迁移和图片核验需单独实施。OSS 配置与受限维护见 [存储说明](oss-storage.md)。
