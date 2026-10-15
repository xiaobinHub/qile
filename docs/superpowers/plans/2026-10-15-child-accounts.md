# 孩子账号管理与本地开发环境实施记录

已批准方案：账号负责登录，孩子承载业务数据，家长按孩子分别授权。

## 环境边界

- 回滚基线 `df70724`；原 RDS 代码 `dcd0cc9`。
- 本次仅本机开发和测试。禁止连接正式 RDS 进行结构升级、测试写入或部署。
- 旧 `server.py`、`db/schema.sql`、生产配置和原启动器继续保留，避免影响仍运行的旧版。
- 新服务使用明确配置、独立本地数据库和端口 18787 / 18788；不读取 `data/rds-config.json` 作为默认配置。
- 生产配置和部署说明作为交付物，发布必须另获用户明确指令。

## 实施任务

- [x] 提交当前代码回滚点并建立开发分支。
- [x] 孩子隔离的 PostgreSQL 存储、账号、会话、邀请和管理 API。
- [x] 服务端业务命令：任务规则及例外、完成状态、积分、礼品、类型、常用配置。
- [x] 家长端账号和孩子管理、具体操作接口、独立管理后台。
- [x] 本机 PostgreSQL 初始化、启动停止脚本、受控旧数据导入及生产部署样例。
- [x] 独立数据库集成测试、浏览器回归、规范及质量审查。

## 模块与接口约定

- `accounts_app.py`：FastAPI 应用工厂 `create_app(config_path, surface='parent')`，两种入口只开放各自路由。启动不自动建表或补造数据。
- `child_service.py` / `child_store.py`：认证、授权及 PostgreSQL 事务。配置必须明确 `environment`、`database`（原 load_config 的字段对象）、`parent_origin`、`admin_origin`。development 仅允许本机地址和 `lele_dev` / `lele_test*` 数据库；production 独立配置，HTTPS origin。
- `business_operations.py`：`default_data(name)`；`apply_operation(data, kind, payload, *, actor_id, revision, now)` 返回新业务对象，服务器生成流水和审计。禁止任意整包替换命令。
- `web/parent.html`：从旧 index.html 复制后改造，保留日历、表单、打印和已有自测；`web/admin.html`：独立账号管理。

JSON 契约：登录 POST `/api/auth/login` `{loginName,password}`；GET `/api/auth/me` 和登录返回 `{user:{id,loginName,nickname,role,mustChangePassword},csrfToken}`。写请求使用 `X-CSRF-Token`，登录检查精确 Origin。

GET `/api/children` 返回 `{children:[{id,name,ownerId,role:'owner'|'parent',archived,membershipVersion}]}`。POST 创建 `{name}`；PATCH `/api/children/{id}` `{name}` 或 `{archived}`；POST `/transfer` `{userId}`；DELETE `/members/{userId}`；GET `/members` 返回 `{members:[{userId,loginName,nickname,role}]}`。

POST `/api/children/{id}/invitations` `{loginName}`；GET 同路径返回 `{invitations:[]}`；DELETE 同路径 `/{inviteId}` 撤销。GET `/api/invitations` 返回本人邀请；POST `/api/invitations/{id}/accept` 或 `/reject`。

GET `/api/children/{id}/data` 返回原 store 数据包并附加 `context:{childId,membershipVersion}`。POST `/operations` `{expectedRevision,membershipVersion,operationId,kind,payload}` 返回同格式最新数据包。GET `/data/export` 返回同格式（不含账号权限）；POST `/data/restore` 使用相同上下文字段加 `data`，只允许 owner，保留目标孩子姓名，递增修订。

命令：`task.create` `{task}`；`task.edit` `{occurrenceKey,task,scope:only|future|all}`；`task.delete` `{occurrenceKey,scope:only|series}`；`completion.set` `{occurrenceKey,completed}`；`ledger.manual` `{amount,reason,date}`；`gift.save` `{gift:{id?,name,points,imageData}}`；`gift.delete` `{id}`；`gift.redeem` / `gift.reverse` `{id}`；`category.save` `{category:{id?,name,color}}`；`category.delete` `{id}`；`category.reorder` `{ids}`；`preset.save` `{preset}`；`preset.delete` `{id}`。每种命令只允许受控字段，不接受客户端生成的流水、快照或任意数组。

PATCH `/api/account/profile` `{loginName,nickname,currentPassword}`；POST `/api/account/password` `{currentPassword,newPassword}`；POST `/api/auth/logout`。改密撤销所有会话。

管理员 GET `/api/admin/users` `{users:[]}`；POST `{loginName,nickname,password}` 创建 parent 并强制首次改密；PATCH `/{id}/status` `{status:active|disabled}`；POST `/{id}/password` `{password}`。管理员不能使用孩子数据接口。初始化 admin 采用本机工具，仅开发凭据写入忽略目录的 0600 文件。

数据隔离、事务内授权检查、不可变上下文、修订冲突与操作防重是强制验收项。归档只读；恢复、改名和转让仅 owner。普通家长可操作业务和导出。
