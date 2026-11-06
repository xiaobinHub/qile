# 美森约课 shadcn/ui 迁移

按用户确认的共享源码、独立打包方式迁移现有插件，保留接口、Token、页面结构与业务行为；不替换主应用页面。

- 共享库：保留现有Button/Input/Calendar/Popover/Card等，官方CLI仅补充缺失的Alert/Avatar/Empty/Field/RadioGroup/ScrollArea/Collapsible/InputGroup。Dialog/Sheet增添可选portalContainer以支持插件嵌套弹层，默认行为不变。
- 插件基础组合：Notice使用Alert，空态使用Empty，教师图片使用AvatarImage/Fallback并保留现有受控图片加载；弹窗使用Dialog，预约和教师档案使用Sheet，确认使用AlertDialog，滚动区域使用ScrollArea。
- 页面组合：教师与预约卡片使用完整Card结构，标签使用Badge，筛选使用Popover/Checkbox/ToggleGroup，课件分类使用Collapsible，课件选择使用RadioGroup，预约状态使用Tabs，表单使用Field/InputGroup，日期继续复用DatePicker。
- CSS：仅保留插件业务布局；移除按钮/输入/卡片/弹层等基础控件的独立外观实现。插件独立生成限定在插件根与弹层容器内的Tailwind utilities，不引入全局preflight或覆盖宿主主题。
- 验证：原宿主加载器中测试登录、筛选、多时段、展开/收起、连续时段、课件选择、嵌套弹层、键盘/焦点、视频播放、移动宽度和主应用样式无变化；静态检查不残留原生控件或dialog/details；构建并部署本机1.0.9，保留原Token和配置。

## 验证与本地交付结果

- 插件、主应用、管理端TypeScript检查通过；语义字号、仓库布局与diff空白检查通过。
- 原主应用加载器浏览器验收通过，包含登录失败保留密码、重复点击、Token复用模拟、筛选竞态、连续时段、课件RadioGroup与嵌套弹层、预约Tabs、视频播放/拖动、焦点恢复、Axe及390/820/1024/1280/1440宽度。
- 插件构建CSS共991条顶层选择器限定在`.mison-ui`内；运行时比较宿主导航样式无变化；离开插件后portal、滚动锁和指针锁清理通过。
- 浏览器证据：`/private/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-CAv0Bi/`（隔离HTTP数据，不代表写入接口已接通）。
- 使用正常插件发布链在本机开发环境部署1.0.9，旧版1.0.8保留；未构建/发布主应用页面或操作生产。更新前后数据库凭据ID、状态、revision及密文指纹一致。
