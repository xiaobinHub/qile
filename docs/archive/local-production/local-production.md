> 历史资料（2026-10-23 起停用）：当前仓库已删除本地生产启动器和控制脚本。生产目标为阿里云，本地仅开发测试。以下内容仅记录旧版实施事实，请勿按其中命令操作当前项目。

# 本地生产版本与开发分支

## 使用入口

| 用途 | 地址 | 代码与数据 |
|---|---|---|
| 正式使用 | http://localhost:8787/ | `乐乐成长-生产/releases/<tag>` 固定发布；原 RDS 正式数据库 |
| 新版家长端开发 | http://localhost:18787/ | `乐乐成长` 工作区的 `codex/child-accounts`；本机开发数据库 |
| 新版管理后台开发 | http://localhost:18788/ | 同上，与正式数据库隔离 |

双击原项目或生产目录中的“启动乐乐成长.app / 停止乐乐成长.app”操作正式服务；双击原项目中的“启动本地测试.command / 停止本地测试.command”操作新版开发服务。

生产控制程序独立位于 `/Users/xiaobin/Desktop/项目/乐乐成长-生产/control.py`，运行时使用生产目录内的 `.venv`。开发目录的 Git 切换、前端修改和依赖安装不会更换生产文件或生产依赖。

## 分支规则

- `main`：当前稳定生产代码及运行管理。2026-10-18 纳入已核验的 RDS 改造，未纳入孩子账号新版。
- `codex/child-accounts`：孩子账号及管理后台开发；合并 main 的运维改动，不发布新版业务到 8787。
- `codex/rds-storage`：保留为历史研发分支；其提交已包含于 main。
- `local-prod-20261018-rds`：此次固定生产发布的不可移动 Git tag。实际完整提交及全部导出文件 SHA-256 见生产 `current.json`。

`main` 后续有新提交不等于自动发布。发布需要显式验证、创建新 tag、导出新目录并更新生产 manifest。生产目录不是开发 Git 工作区，不进行 checkout/pull；不要在那里直接改代码。

## 正式配置与数据

生产 `data/rds-config.json`、`data/storage-mode.json`、`data/lele-lan-access.json` 权限 0600，沿用现有正式连接和局域网口令。`data/logs` 独立记录正式服务日志。生产不依赖开发目录中的任何数据文件，也不会自动回退到 JSON。

原目录内旧 RDS 配置、JSON 和备份保留供核对与回退，已不由生产启动器使用。它们不是最新正式数据库快照；禁止用它们覆盖持续更新的正式业务。开发环境仍只读取 `data/development/config.json`。

正式控制命令（不需要进入开发目录）：

```sh
"/Users/xiaobin/Desktop/项目/乐乐成长-生产/.venv/bin/python" \
  "/Users/xiaobin/Desktop/项目/乐乐成长-生产/control.py" status
```

把 `status` 改成 `start` 或 `stop` 可重启或停止正式服务；`start --open` 也打开页面。启动会校验 manifest 和文件摘要，拒绝配置权限异常、JSON 模式及其他进程占用端口。只操作 `com.lele.growth`，不停止本地开发数据库或新版服务。

## 回退与核对

切换前基线在原项目 `data/production-isolation/baseline/`：正式只读快照、旧 launchd 配置、Git 提交与摘要，不纳入 Git。生产每次启动前还会备份原 launchd 配置到生产 `backups/`。

新服务启动失败时自动恢复旧 launchd 配置并提交重启；随后必须核对旧服务健康状态。成功切换后的固定发布仍可重复校验和重启。若需回退业务代码，应导出已标记的稳定版本到新的独立发布目录，使用其对应控制程序与摘要；代码回退不回滚数据库，不覆盖新业务数据。

已有局域网口令保留；重启会清空旧版进程的内存登录会话，局域网设备可能需要重新输入原口令。本机访问不受此影响。

此次验收结果另见 `docs/local-production-report.md`。
