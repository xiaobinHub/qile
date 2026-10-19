# 家长端设置分栏 Implementation Plan

> 用户已确认设计并授权实施。本次在当前会话逐项执行，不委派子代理。

**Goal:** 以孩子管理、任务设置、账号管理组织家长设置，拆分表单和邀请管理，禁止修改登录名。

**Architecture:** 新增独立设置脚本和样式，以依赖对象访问当前账号、孩子、API、原有编辑器和业务命令。原脚本保留业务上下文和强制改密，列表渲染函数支持设置内的目标容器。资料接口只允许更新昵称，管理员共用表单同步调整。

**Tech Stack:** 原生 JavaScript/CSS、FastAPI、Psycopg/PostgreSQL、React/shadcn 管理后台、Playwright。

---

## Task 1: 锁定账号登录名

Files: `child_service.py`、`test_child_backend.py`、`admin-ui/src/pages/profile.tsx`、`scripts/admin_ui_smoke.cjs`。

- [x] 更新资料回归，断言带正确密码的改登录名请求也返回 400，昵称更新保持登录名及邀请目标不变；同时覆盖管理员。
- [x] 资料接口用以下校验和更新替换原登录名修改逻辑：

```python
require('loginName' not in body,400,'登录名不支持修改。')
require(set(body)=={'nickname'})
nickname=text_value(body['nickname'])
cur.execute('UPDATE lele.users SET nickname=%s WHERE id=%s RETURNING '+USER_COLUMNS,(nickname,user[0]))
```

- [x] 后台资料表单以 `readOnly` 展示原登录名，资料请求改为 `{nickname}`，移除修改登录名所需密码字段；更新真实保存的浏览器断言。
- [x] 使用 `.venv/bin/python -m unittest test_child_backend -v` 搭配显式 `LELE_TEST_CONFIG=data/development/test-config.json` 运行隔离测试，执行 `npm run build:admin`。

## Task 2: 独立设置模块与分栏

Files: 新增 `web/parent-settings.js`、`web/parent-settings.css`；修改 `web/parent.html`、`accounts_app.py`、`web/parent.js`。

- [x] 通过 `window.LeleParentSettings.create(dependencies)` 创建设置控制器；接口为 `render()`、`open(page)`、`invalidate()`、`reset()`。依赖包含当前上下文 getter、API、角色同步、渲染器、编辑器、备份、改密及退出回调。
- [x] 左侧用带分组标题的原生按钮导航，选中项 `aria-current="page"`；右侧用标题、说明、表单或列表承载。定义页面键 `child/profile`、`child/family`、`child/invitations`、`tasks/presets`、`tasks/categories`、`tasks/backup`、`account/profile`、`account/password`。
- [x] 每次 render 增加面板序号，异步回调同时核对当前 DOM、序号与孩子 ID；`invalidate()` 在离开设置和清理孩子上下文时令旧面板失效。
- [x] 将脚本与 CSS 加入家长端资源精确白名单并从 HTML 同源引入；不开放后台源码或任意静态文件。
- [x] 移除旧设置叠加包装和混合孩子管理页面；账号导航改为打开独立设置项，首次改密沿用强制页面。

## Task 3: 独立孩子、任务与账号内容

Files: `web/parent-settings.js`、`web/parent-settings.css`、`web/parent.js`。

- [x] 孩子昵称提交 `PATCH /api/children/{id}` 的 `{name}`，成功刷新孩子列表和当前数据；底部折叠现有归档/恢复/退出管理。
- [x] 家人页通过成员与已发邀请接口读取；发送 `{loginName}`，撤销 DELETE；移除与转让保留确认，所有操作遵循负责人及归档状态。
- [x] 我的邀请读取 `/api/invitations`，分别 POST accept/reject，刷新孩子列表，在页内提供进入按钮；无孩子时保留账号和邀请导航。
- [x] 常用任务与类型列表分别选择设置目标容器；新增与编辑调用原弹窗方法，成功后列表刷新。归档状态禁用写入控件。
- [x] 备份页调用原有导出与导入能力，显示负责人恢复限制和最近保存时间；删除访问地址入口。
- [x] 账号昵称仅提交 `{nickname}`；密码表单维持六位字母数字、重复校验、提交禁用和改密后退出；退出登录先确认。

## Task 4: 隔离浏览器与交付

Files: 新增 `scripts/parent_settings_smoke.cjs`；修改 `scripts/browser_smoke.cjs`、`scripts/children_dialog_smoke.cjs`；构建产物 `web/admin-dist/`。

- [x] 用现有隔离数据库 `lele_test_browser` 验证完整分栏、三个孩子入口、成员权限、邀请处理、昵称持久化、密码规则、任务配置、备份、退出取消；更新旧导航选择器。
- [x] 制造延迟邀请响应后切换面板，断言旧响应不覆盖新内容。验证共同管理与归档状态按钮禁用。
- [x] 捕获桌面和 390px 窄屏截图，断言无横向溢出，人工查看标题、间距、表单和成员列表。
- [x] 运行 `node --check web/parent.js`、`node --check web/parent-settings.js`、`git diff --check`、`npm run build:admin`、隔离后端与 `npm run test:browser`，通过后仅提交本次文件。
- [x] 验证本地开发进程使用当前代码并可读取新资源；向用户交付入口、验证结论和提交号。生产不发布。


## 实施与验证结果

2026-10-19 完成。设计与回滚记录提交为 `7257f7f`，实现已按计划落地。

- 后端集成与密码/环境约束：29 项通过；新增资源白名单检查单独通过。
- 管理后台类型检查和构建通过。
- 隔离浏览器回归：28 个场景通过，页面错误 0，输出 18 张截图；覆盖新版设置、昵称持久化、邀请、角色权限、归档只读、退出取消及原日历/积分/打印。
- 人工查看桌面、邀请列表、任务配置和 390px 手机截图；无横向溢出。
- JavaScript 语法与 Git 空白检查通过。
- 本地开发 18787/18788 已重启加载新版，健康检查通过，设置脚本与样式返回 200。
- 开发库 6 个孩子在重启前后完整数据校验值一致，修订号为 0、0、0、0、0、261；未对开发业务数据写入测试记录。
- 独立本机生产服务 8787 的进程保持不变；本次没有发布阿里云。

验收截图：`output/playwright/parent-settings-child.png`、`parent-settings-family.png`、`parent-settings-invitations.png`、`parent-settings-presets.png`、`parent-settings-account.png`、`parent-settings-mobile.png`。


## 同日五项批注修订（已完成）

用户明确要求取消旧“我的孩子”首页，直接进入任务日历；同时移除设置详情的一级分类重复文案、设置标题右侧的孩子信息与入口，补充邀请发出时间并隐藏撤销邀请。

- [x] `web/parent.js`：根路径优先进入当前账号最近选择的未归档孩子，无有效偏好时回退到首个有权限孩子；显式孩子链接优先。卡牌仍负责切换，无孩子时展示日历空状态及创建/邀请引导，删除旧独立列表页面；请求失败展示错误重试而非生成默认业务数据。
- [x] `web/parent-settings.js` / `.css`：移除详情分类和标题右侧入口；无孩子昵称页提供首次创建表单；已发邀请展示真实日期时间并过滤撤销状态。
- [x] `child_service.py`：已发邀请读取原 `created_at` 为 `createdAt`，查询排除 revoked。保留数据库原行和审计，无结构迁移。
- [x] `test_child_backend.py`：验证发出时间精确匹配数据库，撤销后查询不可见但原行状态仍为 revoked。
- [x] 更新三份浏览器脚本的导航、无孩子引导、卡牌切换及邀请断言；额外测试多孩子根路径、最近选择、无授权偏好回退与重复入口移除。

验证：29 项后端测试通过；30 个隔离浏览器场景通过，页面错误 0；语法和空白检查通过。人工查看更新后的邀请页面，时间与状态清楚，重复入口消失。

本地开发 18787/18788 已重启；重启前后 6 个孩子完整业务数据校验值一致，修订号 0、0、0、0、0、262。8787 独立生产进程未变，阿里云未发布。本轮回滚基线为 `5e4777b`。


## 未绑定孩子账号引导（已完成）

- [x] `web/parent.js`：未绑定时顶部主导航仅设置，初始内容改为独立引导页，取消空日历和积分商城导航；网络错误使用明确错误/重试状态。
- [x] `web/parent-settings.js` / `.css`：初始页直接创建孩子及读取本人邀请，可接受或拒绝；接受或创建成功后进入孩子日历，恢复完整导航。设置按绑定状态过滤分组，未绑定时仅账号管理，默认账号昵称，并可返回开始页。
- [x] 三份浏览器回归脚本适配直接创建和接受邀请；断言未绑定时顶部一个设置 Tab、设置内仅三个账号入口，绑定后恢复三个顶部 Tab 和三类设置。
- [x] 31 个隔离浏览器场景全部通过，页面错误 0；语法与空白检查通过。人工查看桌面初始页和手机账号设置，无布局溢出。
- [x] 本地 18787 健康检查通过，实际提供的 parent.js、parent-settings.js、parent-settings.css 与工作区逐字节一致。本次无后端或数据库结构改动，无需重启；测试仅写 lele_test_browser，独立生产 8787 进程保持不变，阿里云未发布。

截图：`output/playwright/parent-unbound-home.png`、`output/playwright/parent-unbound-settings.png`。本轮回滚基线为 `350e2fd`。

## 首次密码设置页面整理（已完成）

- [x] 首次或管理员重置后的强制改密使用居中卡片，移除日历首页、账号管理和当前密码输入，仅保留两次新密码输入、保存及退出登录。
- [x] 后端根据数据库账号状态接受强制设置的新密码单字段请求，普通改密保留当前密码验证；兼容原客户端提交当前密码且仍验证，不允许伪造状态绕过校验。
- [x] 新增后端验证首次设置、管理员重置后设置、CSRF 拒绝、密码规则、跨会话注销、普通账号缺少当前密码及伪造标记被拒绝。
- [x] 30 项后端测试和 31 个隔离浏览器场景通过，页面错误 0；JavaScript 语法及空白检查通过。人工查看 1098px 桌面和 390px 手机截图，卡片居中、字段清楚且无横向溢出。
- [x] 本地开发 18787/18788 已重启且健康检查通过。6 个孩子完整业务数据重启前后校验值一致，修订号 0、0、0、0、0、262；测试写入仅使用独立测试库。独立生产 8787 进程未变，未发布阿里云。

截图：`output/playwright/parent-password-setup-desktop.png`、`output/playwright/parent-password-setup-mobile.png`。本轮回滚基线为 `62e8b3e`。

## 密码设置五处细节（已完成）

移除底部账号名，退出按钮居中；顶部说明取消强制换行；帮助文案修改为“密码至少 6 位，同时包含数字和字母”；移除强制设置页面的保存后重新登录提示。人工查看更新后的桌面、390px 手机截图，说明均为一行。31 个隔离浏览器场景通过，页面错误 0；脚本语法与空白检查通过。开发服务实际提供的脚本、样式与工作区一致，无需重启，无生产发布。回滚基线为 `dd15cb9`。
