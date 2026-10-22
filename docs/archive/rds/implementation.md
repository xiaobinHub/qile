> 历史资料：本文属于旧版单孩子 RDS v1 实施记录，不是当前多孩子 v4 或阿里云部署指南。本地生产启动工具已删除；当前使用根 README 与 deploy/README.md。

# 乐乐成长 RDS 改造实施记录

已批准的目标：当前 Mac 后端切换 PostgreSQL，数据库 `lele_growth`、Schema `lele`。原数据包接口、局域网口令、前端同步、打印和业务功能保留。

迁移当前正式文件全部业务数据，包括历史完成、积分和业务 operationLog；不导入旧 backups、独立请求日志、运行日志、localStorage 或局域网口令。

各实体独立存行，原始 record_json 与排序位置保证往返等值。任务 revisions 分表，版本状态保留 absent/null/array。读取使用 REPEATABLE READ，保存锁定元信息行，409 冲突保持原语义；旧版本备份和整份业务更新在一个事务提交。

用户最新指示：跳过 RDS SSL 与单独权限检查，当前部署明确使用 sslmode=disable 和 allow_unencrypted=true。配置样例继续默认 verify-full；代码不自动降级。

回退基线：Git 582d002。开发前正式文件 SHA256 c80559079fe916413bb753b0e88c5fe1acf43f279d984701dc1493409485eef5，revision 261，积分 1441。最终切换前重新暂停服务获取最终快照。

配置和留档均位于 Git 已忽略的 data 目录，密码不得提交。测试在临时目录、独立端口和专用数据库中执行。

交付包含14张表结构、数据库存储适配、迁移/核验/导出工具、后台启动兼容、配置样例、操作说明及脱敏迁移报告。
