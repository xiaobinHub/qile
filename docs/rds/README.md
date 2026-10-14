# 乐乐成长 RDS 存储

应用仍在当前 Mac 运行。正式业务使用 PostgreSQL 数据库 `lele_growth`，Schema `lele`；页面地址和局域网口令保持原用法。

## 配置与启动

- `data/rds-config.json`：数据库连接配置，权限 0600，Git 忽略。
- `data/storage-mode.json`：明确选择 `{"storage":"postgres"}` 或 `{"storage":"json"}`。
- `data/rds-cutover.json`：完成切换的留档标记；缺少存储方式时禁止自动回到旧文件。
- 双击现有“启动乐乐成长.app”即可使用后台服务。直接运行 server.py 时也会读取存储方式；只有明确传入 --storage 才覆盖该选择。
- JSON 用于原兼容与明确回退。数据库配置错误、网络断开或没有初始化，都不会自动写入旧本机文件。

独立环境依赖见 requirements.txt。重新安装可执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

连接配置样例见 config.example.json。默认要求证书验证；本次用户明确要求跳过 SSL，实际本机配置使用 sslmode=disable、allow_unencrypted=true。代码不会自动降级。密码不应放入命令参数、日志或提交的文件。

## 数据结构

准确字段、约束和索引见 db/schema.sql。共14张表：应用版本、设置、任务类型、任务系列、规则版本、单次例外、完成记录、积分流水、礼品、常用配置、业务操作、新自动备份、新请求日志、迁移记录。

每个业务实体独立存行；record_json 是原始业务内容，sort_order 保留数组顺序。规则版本拆成子表，effective_json 提供继承后的查询字段，record_json 保留旧版本的原始缺省字段。业务规则仍由现有前端计算，积分余额为所有积分流水金额之和。

GET /api/data 和 /api/data/raw 返回原数据包结构。读取使用只读 REPEATABLE READ；PUT 锁定元信息行、检查版本，在一个事务中备份旧版本并替换业务内容。版本冲突为409，连接失败/未初始化为503。提交结果不确定时要求刷新核验，不自动重试。

## 首次迁移工具

以下操作各自独立，工具不会自动暂停或切换服务。先停止后台服务，再复制并校验当前正式文件。只选择最新正式快照，旧 backups、独立请求日志、运行日志、localStorage 和访问口令均不导入。

```sh
.venv/bin/python migrate_to_rds.py check
.venv/bin/python migrate_to_rds.py create-database
.venv/bin/python migrate_to_rds.py init
.venv/bin/python migrate_to_rds.py import --source data/migration-baseline/latest-final.json --report data/migration-baseline/import-report.json
.venv/bin/python migrate_to_rds.py verify --source data/migration-baseline/latest-final.json
```

初始化必须使用工具，不能先手工执行SQL再要求工具认领未知结构。初始化器识别本工具创建且结构未被改动的版本1；未知结构、非空迁移目标都拒绝覆盖。相同源SHA重复迁移只报告已迁移状态，不覆盖后来更新。数据库密码从本机配置读取。

验证通过才把 storage-mode.json 明确改为 postgres 并恢复服务。新自动备份在后续成功保存时生成，最多30份。业务 operationLog 是迁移的业务历史；独立请求日志仅从迁移后开始记录。

## 导出与回退

```sh
.venv/bin/python migrate_to_rds.py export --output data/latest-rds-export.json
```

导出工具拒绝覆盖已存在的文件。回退前先停止服务，导出最新云端数据，核验 JSON 完整性与版本，再保留本机旧文件、原子替换正式 JSON。随后明确将 storage-mode.json 设置为 json，重新启动应用。无法取得最新云端数据时保持暂停写入，避免继续使用旧版本产生分叉。

## 验证边界

数据库测试必须传入专用本机测试配置，host 只能为 localhost/127.0.0.1，dbname 必须为 lele_test；测试会重建该测试库的 lele Schema。不得使用正式配置。

```sh
LELE_TEST_DB_CONFIG=/absolute/path/to/test-config.json .venv/bin/python -m unittest test_server test_postgres_store test_rds_http -v
```

浏览器自检为 ?selftest=1，不读写正式数据。其他浏览器写入测试必须使用独立端口和临时数据根目录。正式迁移后的浏览器验收只读，并拦截意外写入。
