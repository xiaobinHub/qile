# 云服务器运行与发布包

此目录是当前 FastAPI 应用的 Linux 部署入口。旧版 `legacy/server.py` 和 macOS 启动器不用于云端运行。

## 发布包

在本地仓库根目录完成类型检查、构建及隔离回归后：

```sh
npm run build
.venv/bin/python scripts/package_release.py
```

`output/releases/` 下生成 tar.gz 和 SHA-256 文件。包内 `release-manifest.json` 记录来源提交、未提交状态及逐文件摘要。含未提交变更的包标记 `dirty`，正式发布前应先提交、检查干净的运行代码，再重新构建和打包。

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

运行入口不会初始化、升级、导入数据库或创建账号。当前应用使用 v4 结构，首次云端建库、从旧版迁移和已有图片校验需要独立的发布实施步骤与回退备份；本地开发/媒体迁移工具仍拒绝 production，不应绕过此限制。

数据库版本、对象存储配置、HTTPS、来源/CSRF、管理员账号和访问权限核验通过后，才执行版本链接切换。回退需评估数据库兼容性，不能只把旧程序重新指向升级后的数据库。

本次只准备代码布局和打包工具，未发布阿里云、改动云端配置或操作独立本地生产服务。
