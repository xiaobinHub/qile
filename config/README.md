# 配置示例

此目录只收录不含真实密钥的模板：

- `production.example.json`：数据库和家长/管理入口；部署时填写到服务器 `/etc/lele-growth/production.json`。
- `object-storage.example.json`：合并到应用配置的 `object_storage`，实际凭据文件单独存放，路径相对应用配置文件解析。

应用只读取显式指定的 `LELE_ACCOUNTS_CONFIG`，不自动加载此目录下的模板。开发配置继续在 `data/development/config.json`，不移动现有数据库或凭据。

生产配置和 OSS 凭据均应由服务器服务账号可读、权限 0600，不纳入 Git、静态目录或发布包。示例中的生产数据库 TLS 设置保留现有明确契约，本次目录整理不改变数据库连接策略。
