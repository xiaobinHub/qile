# 美森约课上游核验记录

更新日期：2026-11-06；对应源码候选 1.0.30。本记录按 G01–G07 汇总当前实现及仓库已有证据，替代早期“仅单课时、预览阻塞”的交接结论。本次文档复核没有发起美森在线请求，也没有补做真实预约、取消或额度消耗。

早期证据来自用户提供的《一对一约课功能探索报告.md》《美森API接入要求.md》和“美森 app 接口调用”HAR，不使用“美森自动约课”临时项目。后续 App 静态调用链及 2026-11-03/04 真实只读核验结论已记录在 [API 合同](api-contract.md) 的适配器补充和 [插件说明](../../../plugins/mison-booking/README.md)。这些是既有采样记录，不能视作本次实时重验或授权写入闭环。

| 编号 | 当前实现与已有证据 | 仍需核验的边界 |
|---|---|---|
| G01 | 已实现密码登录与服务端加密凭据；`myOneToOneList` 与 `myCourseList` 动态关联合约 ID、课程班 ID 和课件树 ID，拒绝过期/不匹配/多有效合约。已有真实只读核验记录与隔离测试。 | 当前自动识别仅支持唯一有效一对一合约；`teacherType=2` 为当前适配产品的既有值，不代表所有课程类型。多合约选择和其他产品尚未交付。 |
| G02 | App 静态调用链确认 `courseware_id=ids.join(",")`、`lesson_period=数量`、`dtime=首时段`；当前支持同教师同日连续多课时，一次发送 `onevoneAppointment`。隔离测试检查两课时 CSV、一次派发、部分成功及响应丢失核对。 | 未完成真实多课时预约闭环。38 是适配器上限，还受实际模板和档期约束，不代表所有合约都接受 38 课时；不拆单假称原生批量。 |
| G03 | 预约前更换只修改持久草稿，不扣额度；预览使用当前草稿课件的 `student_file_url` 签发同源 PDF 票据，不调用 `onevonePreviewCourseware`，额度为 0 不阻止选择、预览或预约。已有一份真实学员 PDF 的只读 206/文件头记录，隔离测试检查不扣次及无效来源拒绝。 | 单份文件的记录不保证所有课件可用。无文件/不支持来源时明确报错，不回退到扣次接口；已预约课程的 `onevoneChangeCourseware` 是另一操作，当前未开放。 |
| G04 | 静态证据及隔离状态机覆盖 `cancelLesson` 成功后调用 `onevoneSaveCancelLesson(adjust_lessons=0)`；第二步未知只核对，不重发第一步。 | 真实两步取消闭环尚未执行；额外扣额/顺延规则交给 App 确认，批量排序与顺延仍不可用。 |
| G05 | 学生 PDF 已实现 `courseClassResource` → `download/pdf` → 同源票据/代理，已有真实只读响应及地址记录。教师视频也已接入限域流代理。 | 上课、回放、预习及作业仍提供 App 操作说明；PC 专属协议未交付。不猜 URL，不返回持久 Token。 |
| G06 | 已有真实只读列表核验记录；教师普通池/推荐池去重分页、预约三状态完整扫描后排序/过滤、游标作用域和过期均有隔离测试。 | 上游字段/分页规则改变时需重新采样；当前快照不是上游稳定排序或无限结果规模的保证。 |
| G07 | 分类/推荐/待补学列表已实现并有只读记录；`choosed` 仅表示已选，`learned` 保持 `null`；有效性按返回的状态/分类字段判断。 | 真实“学过”字段、所有作废/待补学非空样本的产品语义仍未全面证实，不补造学习状态。 |

## 仓库内可复核入口

- 合约、教师及预约列表：`plugins/mison-booking/backend/mison_booking/read_api.py`；`tests/backend/test_mison_reads.py`。
- 草稿、预约/取消/收藏、课件及学习资源：`drafts.py`、`operations.py`、`courseware.py`；`tests/backend/test_mison_booking.py`。
- 媒体授权、Range 与文件响应：`backend/lele_growth/plugins/resources.py`；`tests/backend/test_plugin_video.py`。浏览器 iPad 验收额外核对完整合成 PDF 下载，不能据此宣称真实上游文件均可下载。
- 课程同步的绑定/凭据/设置修订、任务/积分及幂等事务：`tests/backend/test_mison_sync_integration.py`；前端协议协商：`tests/backend/test_plugin_frontend_protocol.py`。这些验证宿主链路，不代替上游写入验收。

`tests/fixtures/mison/evidence.json` 保留早期脱敏抓包样本，不是全部后续能力的证据集。合成测试数据用于回归，不能升级为真实接口证据。不得向核验文档或夹具复制真实账号、JWT、Cookie、手机号和密码。

## 发布前尚未完成

真实预约/取消的完整闭环、生产环境迁移与回退演练、物理 iPad 主屏幕模式验收均不能由本记录判定通过。真实写入须另有明确授权及账号/课程范围；既有约束要求测试预约严格晚于操作时刻 48 小时。
