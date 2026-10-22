# 新版本地开发与测试

本次版本增加账号登录、独立管理员后台和按孩子授权的数据管理。一个账号可以管理多个孩子，一个孩子可以授权多个家长。每个孩子拥有独立任务、积分、礼品、配置、修订号和最近 30 份自动备份。

## 本机入口

- 家长端：<http://127.0.0.1:18787>
- 管理后台：<http://127.0.0.1:18788>
- 初始账号：`admin／管理员`、`lele／乐乐家长`。
- 本机随机生成的初始密码在 `data/development/accounts.json`，文件权限 0600、目录权限 0700，均不纳入 Git。家长首次登录必须修改密码。修改后此文件中的初始密码失效。
- 双击项目中的“启动本地测试.command”启动新版，双击“停止本地测试.command”停止 Web 服务。关闭浏览器不会停止服务。

新版开发环境与 8787 正式入口独立。正式服务已固定运行在旁边的“乐乐成长-生产”目录，原“启动乐乐成长.app / 停止乐乐成长.app”只操作独立生产服务；开发 Git 切换不会更换生产页面或依赖。运行说明见 [本地生产管理](local-production.md)，实际版本与验证结果见 [验收记录](local-production-report.md)。新版不会读取旧 RDS 配置作为默认配置，也不会自动从数据库切回 JSON 文件。

## 通过端口转发访问测试环境

外部域名、HTTPS 隧道或映射后的端口与本机地址不同，需要在本机私有配置 `data/development/config.json` 中明确添加可信来源；否则登录和保存会提示“请求来源不受信任”。保留原有 `parent_origin`、`admin_origin` 和数据库配置，只按需添加以下字段：

```json
{
  "parent_trusted_origins": ["http://chenxiaobin.cn:18787"],
  "admin_trusted_origins": []
}
```

每项为浏览器地址的协议、域名/IP 和端口，不包含孩子路径、查询参数或通配符；末尾 `/` 可省略。协议或端口变化后需要更新配置。家长端和管理端分别授权，不能配置相同来源；只转发家长端时保持管理端列表为空。本机 `127.0.0.1`、`localhost` 和同端口的局域网访问继续可用。

修改后停止并重新启动本地测试服务（`dev.py stop` / `dev.py start`），刷新外部页面再登录。来源配置只在启动时读取，不会取消登录、CSRF 或角色校验，也不会信任客户端自行传入的代理头。附加来源仅适用于 development，production 继续使用独立的 HTTPS 来源配置。本配置含数据库凭据，不要上传或粘贴整个文件。

2026-10-22 验证：来源配置与后端回归共 41 项通过，数据库写入仅在专用测试库执行。重启 18787/18788 后，无登录写请求使用指定转发来源及本机来源均进入认证校验（401），未授权来源及跨入口来源仍为 403；私有配置 URL 为 404。8787 生产进程未变。外网浏览器的实际网络连通性仍以外部客户端访问为准。

## 环境安装与初始化

需要 Python 3.13、PostgreSQL 16。项目使用独立 `.venv`，依赖由 `requirements.txt` 固定。可使用系统 pip 或 uv：

```sh
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements.txt
brew install postgresql@16
.venv/bin/python dev.py setup
.venv/bin/python dev.py start
```

若要在首次初始化时导入旧版本机留档副本：

```sh
.venv/bin/python dev.py setup --source data/lele-task-manager.json
```

只读取指定文件，写入独立本机 `lele_dev` 数据库；不会修改源文件、旧备份或正式 RDS。已有开发账号和数据时，重复执行 setup 不会覆盖。此次实际开发库导入的本机留档修订号为 261；它不代表 RDS 当前最新状态。

本机 PostgreSQL 仅监听 `127.0.0.1:55432`，数据目录为 `data/development/pgdata`。应用仅使用 `data/development/config.json`。development 配置拒绝非回环数据库地址及非 `lele_dev` / `lele_test*` 库名，避免误接生产。

```sh
.venv/bin/python dev.py status
.venv/bin/python dev.py stop
.venv/bin/python dev.py test
```

管理员忘记密码时，可在本机交互重置；密码不会进入命令参数或日志：

```sh
.venv/bin/python dev.py reset-admin --login-name admin
```

管理后台源码在 `admin-ui/`，使用 React、TypeScript、Tailwind 和 shadcn/ui。构建需要 Node.js 22.12+（本机使用 22.23.2）。构建文件在 `web/admin-dist/`，由现有 Python 管理服务同源提供，不依赖 CDN，日常运行不需要额外启动前端服务。修改后台源码后先执行构建，再刷新页面；后台 Python 路由变更时还需重启本机服务。

```sh
npm ci
npm run build:admin
```

`npm run check:admin` 只检查 TypeScript 类型。后台构建产物纳入 Git，后续部署使用同一份已验证的产物；服务器运行服务不需要 Node.js。新增生产发布前需先在本机重新构建并测试。

家长端完整源码在 `parent-ui/`，后台在 `admin-ui/`，两端共同使用 `shared-ui/src` 的 shadcn/ui 组件和主题。家长端为单一 React 根节点，日期/重复规则/历史快照/积分/打印计算独立为 TypeScript 模块；没有旧 DOM 渲染或独立挂载桥接。通用控件修改只在共享目录进行，业务日历、孩子卡牌和打印纸张布局仍由功能模块组合。

```sh
npm ci
npm run build
npm run test:domain
npm run check:format
```

`build` 同时检查并构建两端；也可分别执行 `check:parent`、`check:admin`、`build:parent`、`build:admin`。产物为 `web/parent-dist/` 与 `web/admin-dist/`，包含内容哈希，纳入 Git，服务端运行不需要 Node.js。家长页面由 `/` 和 `/children/{id}` 提供，资源仅开放 `/parent-assets/`；后台资源仅开放 `/admin-assets/`。源码、配置和 source map 不公开。修改 Python 路由后需重启本地开发服务，纯前端修改构建后刷新即可；构建期间不要同时运行浏览器回归，以免旧页面请求已替换的分块。

浏览器回归使用专用 `lele_test_unified_ui` 和临时端口 18887/18888，覆盖真实登录、账号、孩子、邀请、任务、积分商城、备份恢复、打印、并发与权限，以及后台原有操作回归：

```sh
npx playwright install chromium
npm run test:browser
```

脚本在重建前检查端口，且只会清理明确命名的本机测试库；结束后停止临时 Web 进程。它使用随机测试密码，截图与 JSON 结果保存在 `output/playwright/shadcn-unified/`。`scripts/browser_smoke.cjs` 保留为新测试的兼容入口。原 `/?selftest=1` 页内自测已由 `npm run test:domain` 的旧实现等值测试和请求状态测试替代。更多组件规则及本次验收见 [共享组件说明](../shared-ui/README.md) 和 [迁移验收报告](shadcn-ui-migration.md)。

测试命令使用 `lele_test_accounts` 和 `lele_test`，测试数据允许清理；不清理 `lele_dev`。数据库保留运行以便后续开发，需停止时可执行：

```sh
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D data/development/pgdata stop
```

## 功能与权限

管理员后台可创建家长账号、启停及重置密码，不提供孩子业务浏览。新设密码至少 6 位，必须同时包含英文字母和数字，最多 128 位，可包含其他字符。所有账号支持修改昵称和密码；登录名由管理员开通后不可修改，改密或管理员重置会撤销该账号所有会话。

家长首次登录后创建孩子，或接受指定孩子的邀请。创建者是孩子管理员。成员可管理业务和导出，孩子管理员额外管理昵称、成员、管理员转让、删除孩子及备份恢复。退出或移除家长保留孩子数据；孩子管理员必须先转让身份才能退出。

“孩子昵称 → 更多孩子管理 → 删除孩子”使用 shadcn/ui 确认弹窗。删除属于逻辑删除：所有成员均失去访问、导出和写入权限，待处理邀请被撤销；底层业务、备份、成员关系和审计保留，不提供恢复入口，不删除家长账号。删除后选择其他可访问孩子，没有孩子时显示创建孩子／接受邀请的开始页。其他已打开页面在请求、获得焦点或每 30 秒检查时退出已删除孩子。已有归档孩子仍只读，管理员可删除；旧归档／恢复接口停止接受状态修改。

### 本地数据库 v2 → v3

结构升级增加 `children.deleted_at/deleted_by` 并更新内部数据库版本，不改业务修订号、业务 JSON、快照或既有迁移报告。新库仍由 `initialize` 创建；已有已知 v2 库可以执行独立升级（重复执行安全）：

```sh
.venv/bin/python dev.py stop
.venv/bin/python child_service.py --config data/development/config.json upgrade
.venv/bin/python dev.py start
```

`initialize` 和本地启动器也支持从已知 v2 结构升级。升级在独占事务内校验原结构标记，未知结构停止，失败整体回滚；所有工具仍拒绝生产配置。`db/schema_v2.sql` 保留作为旧结构基线，新变更位于 `db/migrate_v2_to_v3.sql`。升级后不可将旧版多孩子代码直接指向 v3 库；回退需同时恢复升级前的数据库副本和代码。本版本没有恢复已删除孩子的工具。

修改业务使用明确操作接口，不允许客户端整包覆盖。后端根据当前状态生成历史快照和积分流水，操作编号防止重复提交，成员版本防止退出后旧页面继续写入。不同标签页可管理不同孩子，当前孩子不保存在可变的全局登录会话内。

## 后续生产部署边界

生产由阿里云服务器运行两套 Web 进程，Nginx 使用家长域名和管理员子域名分别转发。部署模板在 `deploy/`，本次没有执行服务器发布、生产建库或生产迁移。

生产配置为服务器上的独立 0600 文件，`environment=production`，浏览器入口必须 HTTPS。数据库 SSL 仍遵从已确认的显式配置，当前模板保留 `sslmode=disable, allow_unencrypted=true`，不自动改变 RDS 设置。

`deploy/run.py` 只运行服务，不自动初始化或升级数据库。本地初始化与导入工具明确拒绝 production 配置。未来收到发布指令后，再确认真实域名、服务器与最新数据快照，并交付经过演练的生产迁移命令。

## 回退与代码结构

孩子账号改造前回滚基线为 `df70724`，原 RDS 工作版本为 `dcd0cc9`。原 RDS 稳定代码现已纳入 `main`，正式发布固定为 `local-prod-20261018-rds`。保留 `server.py`、`postgres_store.py`、`index.html` 和旧建表文件供版本对照；原启动器已改为操作独立生产目录。正式服务仍连接原 RDS，未升级为新版多孩子结构。

新入口为 `accounts_app.py`，事务与授权为 `child_service.py`，孩子存储为 `child_store.py`，业务命令为 `business_operations.py`，家长前端源码为 `parent-ui/`，共享组件为 `shared-ui/`，后台源码为 `admin-ui/`，后台运行产物为 `web/admin-dist/`，账号结构基线为 `db/schema_v2.sql`，当前增量升级为 `db/migrate_v2_to_v3.sql`。

本次后台重构前回滚点为 `79d7757`。后台只调整界面与静态资源提供方式，不改变账号、授权或孩子业务表结构。

正式入口与本地新版可并行运行；停止本地新版不影响正式服务。不要把旧版程序指向新版多孩子数据库，也不要用旧备份覆盖已产生新业务的数据库。不要在开发目录直接运行默认 8787 的 `server.py` 代替正式启动器。
