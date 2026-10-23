# 云服务器运行与发布包

此目录是当前 FastAPI 应用的 Linux 部署入口。旧版 HTTP 服务、局域网口令功能和 macOS 生产启动器已从当前项目移除。

## 发布包

在本地仓库根目录完成类型检查、构建及隔离回归后：

```sh
npm run build
.venv/bin/python scripts/package_release.py
```

`output/releases/` 下生成 tar.gz 和 SHA-256 文件。默认要求全部源码、构建结果与发布输入均已提交，工作区干净；新增未跟踪文件、暂存变更及删除也会阻止正式打包。构建后先提交确认的构建结果，再打包。

包内 `release-manifest.json` 记录来源提交、用途、未提交状态及逐文件摘要。仅本地验收可加 `--allow-dirty`，包名带 `dirty`、用途为 `development`，不能作为正式发布验收结果。两端 Vite 清单会随包保存；打包时核对 HTML、静态及动态分块、CSS、字体的依赖与路径，缺失资源或外部资源即拒绝。构建清单不通过网站公开。

仅包含当前后端、SQL、两端静态资源、依赖清单、第三方许可及必要部署模板/说明；不包含测试、旧版入口、前端源码、node_modules、虚拟环境、运行数据库、日志和密钥。不要打包整个工作目录上传。生成发布包不会连接云服务器，也不会执行数据库升级。

## 运行布局

```text
/opt/lele-growth/releases/<version>/  解压后的独立版本目录
/opt/lele-growth/current             指向经过验证的版本
/etc/lele-growth/production.json     应用配置，0600
/etc/lele-growth/oss-credentials.json 私有 OSS 凭据，0600
```

每个版本创建独立虚拟环境，用 `python -m pip install .` 安装包及依赖。项目包含 `pyproject.toml` 与 `backend/lele_growth/`，不再依赖根目录散落的 Python 模块。前端已构建，运行服务器不需要 Node.js。

配置模板位于 `config/production.example.json`，OSS 字段参考 `config/object-storage.example.json`。把模板中的示例值替换为真实配置，写到 `/etc/lele-growth/`，不要在仓库内保存真实凭据。

生产入口：

```sh
LELE_ACCOUNTS_CONFIG=/etc/lele-growth/production.json \
LELE_SURFACE=parent .venv/bin/python deploy/run.py
```

另一个进程设置 `LELE_SURFACE=admin`。模板使用 `127.0.0.1:8787/8788`，由 Nginx 分别代理家长端和管理端 HTTPS 域名。`run.py` 根据自身位置加载发布包内后端及静态资源，支持从其他工作目录调用。

`lele-growth@.service` 中的版本路径和 `/etc/lele-growth/production.env` 应与服务器一致。`nginx.example.conf` 是待填写真实域名和证书路径的模板。启用 systemd/Nginx 前先审阅现有服务与端口，避免覆盖其他应用。

## 数据与切换边界

运行入口不会初始化、升级、导入数据库或创建账号。当前应用使用 v4 结构；离线维护使用独立的 `manage.py`，不能把生产配置伪装成 development。

## 离线初始化、升级与管理员引导

在服务器维护窗口，以配置所属的服务账号运行。配置必须为该用户拥有、权限 0600 的普通文件；不接受配置符号链接。先停止两个应用进程，保留数据库原生备份/恢复点和旧发布包；按服务器数据库流程验证恢复能力。本工具不会自动备份或回滚已提交的数据库升级。

默认只读预览，不写表、不上传或删除 OSS 对象：

```sh
.venv/bin/python deploy/manage.py initialize --config /etc/lele-growth/production.json
```

核对输出的数据库主机、库名、两个 HTTPS 入口、OSS 桶/前缀。只有完全匹配预期，才复制本次输出的 `targetId` 执行：

```sh
.venv/bin/python deploy/manage.py initialize --config /etc/lele-growth/production.json \
  --apply --confirm TARGET_ID_FROM_PREVIEW
```

空库创建 v4；已知 v2/v3 结构按事务升级至 v4；v4 重复执行不改变数据、不重复写升级审计。结构指纹或版本标记不匹配会停止；`upgrade` 子命令只允许已初始化的已知结构。目标确认在连接前检查，配置中的目标字段变化后须重新预览。升级保持业务内容与业务修订号，新增维护审计。

首个管理员仅在账号表完全为空时允许引导；预览无需提供密码，执行时在交互终端两次输入，不支持命令行/环境变量/管道传密码：

```sh
.venv/bin/python deploy/manage.py bootstrap-admin --config /etc/lele-growth/production.json
.venv/bin/python deploy/manage.py bootstrap-admin --config /etc/lele-growth/production.json \
  --apply --confirm TARGET_ID_FROM_PREVIEW --login-name admin --nickname 管理员
```

创建后首次登录必须修改密码，已存在任何账号时拒绝再次引导。已有管理员的重置走现有账号管理流程；本入口不提供覆盖账号、历史业务导入或图片迁移。开发入口继续拒绝 production，日常启动不调用维护命令。

## OSS 暂存清理

只处理超过 24 小时、没有业务或历史引用且无有效上传租约的暂存/失败对象，以及先前清理未完成的删除标记。已附加对象和历史引用均保护；不会全桶遍历删除，不清除已删除孩子的历史对象。要求有效的私有 OSS 配置。

```sh
.venv/bin/python deploy/manage.py cleanup-staged --config /etc/lele-growth/production.json
.venv/bin/python deploy/manage.py cleanup-staged --config /etc/lele-growth/production.json \
  --apply --confirm TARGET_ID_FROM_PREVIEW
```

清理预览返回候选数量，实际执行会重新检查引用和租约，不保证与预览数量相同。持有单清理进程锁及孩子级锁，在删除对象前提交持久删除标记；失败后不会恢复为可附加状态，重复原维护命令可安全重试。开始、完成和失败写维护审计，日志不包含凭据或图片内容。失败审计本身不可写时，原删除标记仍保留。首次生产执行须人工核对预览并观察结果，本轮不自动安装定时任务。

数据库版本、对象存储配置、HTTPS、来源/CSRF、管理员账号和访问权限核验通过后，才执行版本链接切换。回退需评估数据库兼容性，不能只把旧程序重新指向升级后的数据库。

本地验证仅使用隔离测试数据库和临时对象存储。未发布阿里云、连接正式库、执行真实 OSS 清理或操作已退役的本地生产服务；正式服务器的连接、权限及恢复能力仍需部署时验收。

## 旧版单孩子生产库迁移

`deploy/migrate_legacy.py` 是独立离线工具，只接收私有的旧版当前业务记录，不导入旧快照、请求日志或本地测试账号；这些原始资料应保留在迁移外部备份中。目标必须是已经初始化的独立 v4 库、有效的正式家长账号且无孩子数据。默认预览，执行需要目标 `targetId`、来源规范化 SHA-256 及明确 `--apply`：

```sh
.venv/bin/python deploy/migrate_legacy.py --config /etc/lele-growth/production.json \
  --source /var/lib/lele-growth/migration/source.json --source-sha256 SOURCE_CANONICAL_SHA256 \
  --owner-id PRODUCTION_PARENT_ID
```

核对预览后添加 `--apply --confirm TARGET_ID_FROM_PREVIEW`。保留业务修订号、原始时间、任务/规则/例外/完成/积分和业务操作历史；图片从 Base64 转为私有 OSS 引用并逐个读回验证。只有图片引用变化，转换后的整份业务记录必须逐字节等值。重复执行不重导、不重复审计；目标已出现后续变化时拒绝覆盖。中断后以同一来源重试，确定性对象键保证不新增重复图片。

切换前必须冻结旧入口的写入并重新确认来源摘要，域名/HTTPS/权限检查通过后才开放新入口。旧数据库保持原样，不执行原库就地升级；新旧入口不能同时对两套分叉数据提供日常写入。未完成域名备案或证书时仅内部准备，不能宣称正式上线。
