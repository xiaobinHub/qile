# Vega 主题更新 b2BplS640

日期：2026-10-21。改造前回滚点：`421d74a`。

读取官网 `https://ui.shadcn.com/init?preset=b2BplS640`，确认相较 `b2C8W74qG` 仅 style 从 `base-maia` 变为 `base-vega`；原始 light/dark CSS 变量逐项相同。新预设保存在 `shared-ui/preset.json`。

继续采用官方对应的 `radix-vega` 组件，保留现有 Radix 行为与兼容接口。组件来源及哈希更新至 `shared-ui/registry-provenance.json`，三份 `components.json` 同步为 Vega。没有增加依赖、API 或数据库迁移。

- 按钮、输入、菜单、日期选择及切换控件采用 Vega 的较小圆角、边框和阴影。
- 卡片和弹窗使用 xl 圆角；移除页面 CSS 对 Maia 大圆角的覆盖，孩子卡牌的尺寸、头像和插画保留。
- 继续使用黄色、Mist、Inter、Lucide，以及已验证的说明文字/危险文字对比度适配。
- 保留 40px 桌面控件、44px 触屏目标、中文标签、弹层层级及纵向键盘配置。
- 打印专用 CSS 块逐项保持一致，业务代码未改动。

验证：两端 TypeScript 检查、构建、格式及差异检查通过；隔离数据库 `lele_test_unified_ui`、18887/18888 端口执行 22 组浏览器回归，覆盖 360/390/430/768/1280px，9 次可访问性扫描零违规，页面脚本错误为 0。人工检查手机登录、任务表单及后台截图。测试证据位于忽略目录 `output/playwright/shadcn-unified/`，未在真实业务数据中执行写入测试。

本地开发预览：家长端 http://127.0.0.1:18787/ ，管理后台 http://127.0.0.1:18788/ 。刷新页面加载新版。此次只更新本地开发环境，未发布阿里云或操作独立生产环境。
