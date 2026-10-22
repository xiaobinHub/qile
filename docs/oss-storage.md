# OSS 图片存储

本轮只更新本地开发家长端 18787、管理端 18788 和 `lele_dev`。独立生产 8787、生产目录、生产数据库及阿里云应用发布未参与。

## 配置

把 [配置示例](../config/object-storage.example.json) 的 `object_storage` 字段合并到现有私有配置，保留数据库与可信来源字段。Endpoint 使用区域地址，不使用 Bucket 完整地址。开发前缀固定为 `lele-growth/development`；生产未来使用独立 `production` 前缀。

`credentials_file` 相对于配置文件解析，仅允许当前用户访问（权限 0600），内容为 `access_key_id` 和 `access_key_secret` 两项。也可省略该项，通过 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 注入。示例、源码和前端不保存密钥。当前凭据位于 Git 忽略的 `data/development/oss-credentials.json`，不要复制到前端或提交。

Bucket 和上传对象保持 private。正常应用需要限定项目目录的读取、上传及设置对象私有 ACL 权限；清理工具另需相应对象删除权限。不要为这个项目调整全桶 CORS、ACL 或生命周期。建议使用受限 RAM 凭据，并在本机私有配置替换曾在对话中提供的密钥。

新环境先安装 `requirements.txt` 约束的依赖（包括 `certifi>=2026.10.19`）并构建两端。使用 `uv pip install --python .venv/bin/python -e .`，然后运行 `npm ci` 和 `npm run build`。有旧业务数据的库应先停服并保存私有完整备份，再显式升级：

```sh
PYTHONPATH=backend .venv/bin/python -m lele_growth.child_service --config data/development/config.json upgrade
PYTHONPATH=backend .venv/bin/python -m lele_growth.media_migration --config data/development/config.json
PYTHONPATH=backend .venv/bin/python -m lele_growth.media_migration --config data/development/config.json --apply --backup-dir data/development/oss-migration-backup
.venv/bin/python scripts/dev.py start
```

备份目录必须仅当前用户可访问（0700）；工具新建时自动设置。结构升级支持 v2/v3 到 v4、重复执行及全新初始化，不修改业务修订号。未知结构拒绝升级。仅结构升级尚不代表图片迁移完成；必须执行迁移并确认残留为零再恢复写入。工具拒绝 production 环境。

## 文件与权限

图片在浏览器压缩，原图选择上限 10MB，上传上限 180KiB，支持 PNG、JPEG、WebP。后端验证实际解码格式、尺寸、帧数、大小及内容摘要，不接受 SVG 或任意附件。后续附件类型应在此适配层增加明确的用途、格式和限制。

OSS Key 为 `{prefix}/children/{childId}/images/{sha256}.{extension}`。同一孩子相同内容复用对象，不做跨孩子去重。数据库 `media_assets` 仅存对象位置、SHA-256、MIME、尺寸、字节数和关联状态，礼品及历史记录仅存 `imageAssetId`。

前端显示由后端生成的同源 `imageUrl`，该字段不持久化。读取必须通过当前登录、孩子成员和删除状态检查。暂存图片仅上传者可看；已关联图片允许该孩子成员查看。归档只读，删除后所有成员均不可读。响应为 `private, no-store` 并有 `nosniff`；浏览器不接触 AccessKey 或长期公开链接。

## 接口与失败处理

- `POST /api/children/{id}/assets`：原始二进制；`Content-Type` 为真实图片类型。须携带 `X-Upload-Id`、`X-Membership-Version`、来源、CSRF 和 Cookie。返回 `assetId`、`status`、就绪后的 `imageUrl`。
- `GET /api/children/{id}/assets/uploads/{uploadId}`：仅上传者查询原请求状态。
- `GET /api/children/{id}/assets/{assetId}`：经孩子权限校验读取。
- `gift.save`：保存 `imageAssetId`（移除时为 null），沿用现有业务操作 ID、修订号和成员版本保护。

上传先验证登录、来源、CSRF、孩子权限与成员版本，再解码图片；每账号每分钟最多 60 次上传，每个 Web 进程最多并发处理 4 个上传，超限返回 429 并保留原上传编号。多进程部署时该应用内限制按进程生效，应在网关配置整体限流。上传意图、OSS I/O、上传完成分别处理；OSS 上传和字节读回校验不持有数据库锁，完成后重新检查身份、孩子及成员版本。上传不增加业务修订号；保存礼品时在业务事务中完成关联。

同一上传编号和内容可安全重试；同编号不同内容拒绝。上传中租约为两分钟，过期或失败可沿用原编号重新提交，活跃重复请求只返回 uploading。断网或结果不明确时前端先查询原编号，再重试，保存按钮在图片未就绪时禁用。输入、预览和原编号保留；取消或移除图片不会修改当前礼品。

切换孩子、退出、撤权中止浏览器请求并隔离迟到结果；网络上传已经到达 OSS 的文件只作为暂存/失败对象，不会绕过最终权限检查变为可引用业务图片。OSS 故障没有 Base64 落库的回退路径。

## 内部历史和运维迁移

存量迁移扫描所有非生成 JSON/JSONB 列，包含礼品、快照、业务日志、审计、迁移记录和已删除孩子。只改实际 `imageData` 字段，移除空占位，保留各历史版本对应图片；生成列随源 JSON 自动清空。无法确定孩子、损坏图片、变化中的源记录或错误快照摘要会使迁移停止，保留原字段。重复执行安全。

工具在数据库外保存原始受限备份和逐记录摘要清单；每个孩子在锁内核对源摘要后提交，更新快照内容摘要，保留业务修订号、历史时间、权限和原幂等指纹。全库再次扫描 `imageData`，数量及字节数必须为 0；不能仅统计当前礼品。

家长端数据备份菜单、JSON 导出及导入恢复已删除；`GET /api/children/{id}/data/export` 与 `POST /api/children/{id}/data/restore` 不再开放。旧页面不能通过恢复接口整包覆盖业务。普通读取的数据兼容处理位于 `frontend/parent/src/domain/normalize.ts`，不提供文件导入功能。

内部历史快照继续按原规则保留，旧的受限 `import-child` 仅供运维一次性迁移旧版本数据库原始留档，不能由网页触发，不是家长导入备份入口。数据库外已有原始留档及历史审计不会因功能删除而清除。打印及 PDF 保持现有用途；本轮没有自动启用云厂商独立备份策略。

## 清理与回退

取消表单产生的文件不立即删除。未关联、未被当前或历史 JSON 引用、超过 24 小时且无活跃租约的暂存/失败对象才可清理。同一对象 Key 有其他关联时保留。

执行清理时先在孩子锁内提交 `state=deleted` 与待处理标记（复用 lease 字段），使记录不可预览或关联；提交成功后才在事务外执行 OSS 删除。成功后清除待处理标记，失败时保留标记，下一次执行继续重试。多个对象中途失败或确认提交失败，都不会将已删除的文件恢复为 staged。处理期间同 Key 的新上传返回 409，避免物理删除与重传相互覆盖。清理进程使用独立数据库会话维护锁，阻止并发清理；网络 I/O 不持有业务事务。

该实现沿用现有 v4 字段与枚举，无需新增数据库升级。不要在新清理产生待处理标记后回退到不理解标记的旧上传/清理代码。

清理默认预览，不自动运行或配置全桶生命周期：

```sh
PYTHONPATH=backend .venv/bin/python -m lele_growth.media_migration --config data/development/config.json --cleanup-staged
PYTHONPATH=backend .venv/bin/python -m lele_growth.media_migration --config data/development/config.json --cleanup-staged --apply
```

替换图片、删除礼品或逻辑删除孩子均不物理删除已关联历史图片。已关联对象的永久清理另行设计。PostgreSQL 的旧行/TOAST/WAL 按正常维护策略回收，逻辑残留为零不保证磁盘文件立刻缩小。

日常回退必须使用理解 v4 和 OSS 引用的兼容代码，保留现有配置和元数据，不回写 Base64。原始数据库备份仅用于隔离恢复与核验；不得直接覆盖当前库，否则会重引入图片且丢失新业务操作。先将备份恢复到独立库，使用图片迁移工具归一化，再制定切换步骤。不得把旧的 v3 前端/服务直接连到 v4 库。回退包位置记录在本轮验收报告。

## 隔离测试

`test-filesystem` 只允许 development 且库名为 `lele_test*`；不能用于 `lele_dev` 或 production。真实 OSS 测试还要求独立 `checks` 或 `tests` 前缀。自动化测试不会使用开发前缀。

```sh
LELE_TEST_CONFIG=data/development/oss-test-config.json PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_child_backend tests.backend.test_child_schema_upgrade tests.backend.test_media_storage -v
npm run test:domain
npm run build
npm run test:browser
```

浏览器回归使用独立的 `lele_test_unified_ui`、18887/18888 和本地测试对象目录。Browser 插件未提供，本轮使用项目现有 Playwright 回归。真实 OSS 验证仅创建专用 checks 目录下的测试对象，读回核验、确认匿名 403 后清理本次对象；不列举或删除其他项目内容。
