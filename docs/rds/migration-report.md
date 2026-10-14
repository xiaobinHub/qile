# 乐乐成长 RDS 迁移报告

完成日期：2026-10-15（Asia/Shanghai）。数据库：`lele_growth`，Schema：`lele`，服务器 PostgreSQL 18.6。

正式后台服务已使用独立 Python 环境连接 PostgreSQL；`/api/health` 返回 storage=postgres、databaseReady=true。现有启动器再次重启成功，正式网页只读验收无脚本错误、无自动写入。

## 迁移结果

- 源版本与目标版本：261。
- 积分余额：1441。
- 完整数据重组与最终源快照逐字段等值。
- 源文件 SHA-256：`c80559079fe916413bb753b0e88c5fe1acf43f279d984701dc1493409485eef5`。
- 业务内容规范化 SHA-256：`4b740709a2f90883e11194facd73989bd07580026abd5f0b4d888b974951f7c9`。

| 数据表 | 导入数量 |
|---|---:|
| `app_metadata` | 1 |
| `app_settings` | 1 |
| `task_categories` | 7 |
| `task_series` | 49 |
| `task_revisions` | 49 |
| `task_exceptions` | 23 |
| `task_completions` | 112 |
| `points_ledger` | 122 |
| `gifts` | 2 |
| `task_presets` | 9 |
| `business_operations` | 114 |
| `data_snapshots` | 0 |
| `request_logs` | 0 |
| `migration_runs` | 1 |

旧备份、独立请求日志、运行日志、浏览器 localStorage 和访问口令均未导入。业务 operationLog 已完整迁移。本机原正式文件 SHA-256 保持不变，原30份历史备份仍保留。

## 验证

- 36项本机单元、数据库事务、HTTP与存储配置测试全部通过。
- 前端自检47/47通过。
- RDS专用测试库验证合成数据往返、保存备份、并发写入一成功一409、重复迁移不覆盖更新、无效写入不改变数据。
- 正式接口读取完整数据与迁移快照等值；正式浏览器验收拦截全部非GET/HEAD请求，无意外写入。
- 原启动器重新注册并重启后台服务成功。首次启动曾等待Mac读取Python环境配置，服务就绪后再次重启已通过；云端连接就绪探测等待已加长。
- 本次没有在真实iPad上重新验证系统打印对话框；打印业务代码保持原样，相关前端自检已通过。

## 配置与回退

按用户最新要求，本次实际连接使用 sslmode=disable、allow_unencrypted=true，未启用SSL，也未执行单独的权限专项检查。建库、导入和读写测试均已实际成功。

连接密码仅保存在本机 `data/rds-config.json`，权限0600，Git忽略；报告、代码和配置样例不包含密码。

代码回退基线为 `582d002`，主要改造提交为 `240233b`。最终快照、导入报告和原后台服务配置保存在本机 `data/migration-baseline/`。回退前须先暂停服务；云端有新写入时，先导出并核验最新数据，再恢复本机JSON并明确选择json模式。无法取得最新数据时保持暂停写入。

操作说明见 README.md；准确字段及约束见 db/schema.sql。
