# 新版本地开发与测试

本次版本增加账号登录、独立管理员后台和按孩子授权的数据管理。一个账号可以管理多个孩子，一个孩子可以授权多个家长。每个孩子拥有独立任务、积分、礼品、配置、修订号和最近 30 份自动备份。

## 本机入口

- 家长端：<http://127.0.0.1:18787>
- 管理后台：<http://127.0.0.1:18788>
- 初始账号：`admin／管理员`、`lele／乐乐家长`。
- 本机随机生成的初始密码在 `data/development/accounts.json`，文件权限 0600、目录权限 0700，均不纳入 Git。家长首次登录必须修改密码。修改后此文件中的初始密码失效。
- 双击项目中的“启动本地测试.command”启动新版，双击“停止本地测试.command”停止 Web 服务。关闭浏览器不会停止服务。

新版开发环境与原本 8787 端口上的旧版入口独立。原启动器保留用于回退。新版不会读取旧 RDS 配置作为默认配置，也不会自动从数据库切回 JSON 文件。

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

浏览器回归使用额外的 `lele_test_browser` 隔离库和临时端口 18887/18888，覆盖账号开通、首次改密、多孩子隔离、邀请、任务、礼品、备份权限及退出。Node.js 仅用于开发测试，生产服务不需要 Node.js：

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

浏览器脚本只会重建明确命名的本机 `lele_test_browser`，测试结束停止临时 Web 进程。截图写入已忽略的 `output/playwright/`。新版页面在 `/?selftest=1` 还保留 47 项纯业务自测，不读取业务数据库。

测试命令使用 `lele_test_accounts` 和 `lele_test`，测试数据允许清理；不清理 `lele_dev`。数据库保留运行以便后续开发，需停止时可执行：

```sh
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D data/development/pgdata stop
```

## 功能与权限

管理员后台可创建家长账号、启停及重置密码，不提供孩子业务浏览。新设密码至少 6 位，必须同时包含英文字母和数字，最多 128 位，可包含其他字符。所有账号支持修改登录名、昵称和密码；修改登录名须验证当前密码，改密或管理员重置会撤销该账号所有会话。

家长首次登录后创建孩子，或接受指定孩子的邀请。创建者是负责人。共同管理家长可管理业务和导出，负责人额外管理姓名、成员、负责人转让、归档及备份恢复。退出或移除家长保留孩子数据。归档只读，负责人可以恢复；不提供永久删除。孩子负责人必须先转让身份才能退出。

修改业务使用明确操作接口，不允许客户端整包覆盖。后端根据当前状态生成历史快照和积分流水，操作编号防止重复提交，成员版本防止退出后旧页面继续写入。不同标签页可管理不同孩子，当前孩子不保存在可变的全局登录会话内。

## 后续生产部署边界

生产由阿里云服务器运行两套 Web 进程，Nginx 使用家长域名和管理员子域名分别转发。部署模板在 `deploy/`，本次没有执行服务器发布、生产建库或生产迁移。

生产配置为服务器上的独立 0600 文件，`environment=production`，浏览器入口必须 HTTPS。数据库 SSL 仍遵从已确认的显式配置，当前模板保留 `sslmode=disable, allow_unencrypted=true`，不自动改变 RDS 设置。

`deploy/run.py` 只运行服务，不自动初始化或升级数据库。本地初始化与导入工具明确拒绝 production 配置。未来收到发布指令后，再确认真实域名、服务器与最新数据快照，并交付经过演练的生产迁移命令。

## 回退与代码结构

改造前回滚基线为 `df70724`，原 RDS 工作版本为 `dcd0cc9`。本次保留 `server.py`、`postgres_store.py`、`index.html`、旧建表文件和旧启动器，正式配置未切换。

新入口为 `accounts_app.py`，事务与授权为 `child_service.py`，孩子存储为 `child_store.py`，业务命令为 `business_operations.py`，前端为 `web/parent.*` 和 `web/admin.*`，新结构为 `db/schema_v2.sql`。

停止本地新版即可继续使用原入口。不要把旧版程序指向新版多孩子数据库，也不要用旧备份覆盖已产生新业务的数据库。
