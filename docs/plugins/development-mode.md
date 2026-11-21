# 插件本地开发模式

在仓库根目录运行：

```sh
npm run plugin:dev -- mison-booking
npm run plugin:dev -- mison-booking --with-backend
```

第一条仅热更新前端，接口使用已安装后端；第二条同时加载后端源码。首次安装此开发工具后，先通过 `.venv/bin/python scripts/dev.py restart` 加载新的宿主及运行服务；以后通过 `.venv/bin/python scripts/dev.py start` 启动本地应用，插件须已有兼容的安装版本。继续使用原主应用插件入口，首次启动开发模式后刷新页面。页面和终端会注明运行来源。

开发资源代理会按浏览器支持对较大的 JavaScript/CSS 使用 gzip，减少外网源码加载的传输量。若浏览器提示动态模块加载中断，页面提供“刷新页面”入口；浏览器会缓存含顶层 await 的模块求值失败，单纯重试同一模块地址无法恢复。此处理只解决失败缓存，首次网络中断仍需结合浏览器 Network/Console 和服务端请求日志定位。

开发模式不会修改安装版本号，不会打包或发布。Vite 资源和热更新连接通过本地应用同源路径代理。修改插件及共享 UI 源码后，组件自动更新；入口变化可能重新挂载。权限和数据结构仍以已安装版本为基线，修改 manifest、配置结构或依赖锁文件需要退出并重新检查。

宿主源码热重启会恢复仍处于就绪状态的后端源码会话，并重新校验前端进程、会话标识及安装兼容性；失败或已退出的会话不会自动恢复。

后端源码模式使用独立环境。保存 Python 后合并短时间连续修改，停止接收新请求，等待已有请求完成后重启该插件。开发重载不得为追求速度强行终止业务请求；超时会报错并保留待处理状态。生产入口不提供开发服务。

按 Ctrl+C 正常退出，等待停止完成。已打开页面会识别开发会话结束并刷新整页，清除开发样式、模块缓存和热更新连接，再回到已安装版本。普通组件保存及后端代次更新不要求刷新整页。服务崩溃时不会悄悄回退；修复后重新启动并重试。前台命令会随启动它的终端结束。需要在关闭终端后继续热更新时，使用脱离终端的管理命令：

```sh
.venv/bin/python scripts/dev.py plugins-dev-start mison-booking
.venv/bin/python scripts/dev.py plugins-dev-status mison-booking
.venv/bin/python scripts/dev.py plugins-dev-stop mison-booking
```

`plugins-dev-start` 会复用仍在运行的会话；如果登记进程已经退出，先执行 `plugins-dev-stop` 清理失效登记，再重新启动。日志写在本机私有文件 `data/development/plugin-dev/mison-booking.terminal.log`。修改 `plugin.json`、配置结构或依赖锁仍会主动退出，这是为了避免源码与已安装版本不兼容后继续提供开发资源。

如果终端意外关闭，也可使用：

```sh
.venv/bin/python scripts/plugin_dev.py stop mison-booking
```

共享 UI 按插件独立编译，开发和构建共用样式隔离规则。其他插件的工具类容器采用 `.<plugin-id>-ui`；美森沿用 `.mison-ui`。弹层须放在同一隔离容器下。

数据库中的美森 Token 沿用现有凭据存储，工具不会登录或重放业务提交。开发模式仍可访问真实上游；自动验证使用模拟接口。任何真实约课测试都必须在提交时检查每个课时距离当前时间超过48小时。

验收完成后按原有流程构建、打包、验证安装制品并发布。源码开发不能替代安装制品验收。

自动验收：`PLUGIN_DEV_ACCEPTANCE=1 node tests/browser/mison_frontend_acceptance.cjs` 会在模拟接口下验证组件/CSS热更新与页面流程；测试期间临时修改的源码会在 finally 中恢复，避免同时在另一个编辑器修改相同文件。验收服务器的模块缓存放在各自临时目录，不共用正在运行的插件开发缓存。

源码后端模式暂停该插件的已安装定时任务调度，当前用于页面接口联调；定时任务需退出源码后端模式后单独验收。前端模式保留既有后台任务。

真实同源代理验收：`node tests/browser/plugin_development_proxy.cjs`，使用临时 FastAPI 宿主、模拟认证及业务，验证 CSP、HTTP/WebSocket 权限、热更新及会话退出清理。

动态模块中断恢复及压缩验收：`node tests/browser/plugin_development_proxy.cjs --no-source-edits --module-recovery`。该模式故意中断一次开发入口请求，确认失败求值被当前文档缓存，再验证刷新恢复及代码解压一致性；不改源码或真实数据。
