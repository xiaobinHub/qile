# 美森自动约课

用户于 2026-11-12 确认实施。设计图仅表达功能与信息层级，落地使用现有项目的共享组件、主题、字体、布局及插件生命周期规范。

## 行为

每个儿童与美森账号一套策略；从收藏中添加老师并排序，月历多选日期，为周一至周日配置有序开课时段。以老师优先、时段次优的顺序，在选中日期命中即预约，每天最多一节，手动预约及已上课程也计入。默认提前 25 小时，可设置非负整数；使用最新推荐课件。明确取消后、任务仍开启时自动补约；不自动取消或更换现有课程。

后台运行与浏览器无关。正常一轮完成后随机等待 240–360 秒；默认北京时间 23:00–08:00 休眠。每次新写入前复查任务、配置版本、绑定、休眠、当天已有课程与时段状态。服务重启恢复持久状态，不补跑错过轮次。未知写入结果只核对，不能重发。账号级写入互斥，同一账号跨儿童只允许一套开启策略。停止不撤销已发请求，继续核对其结果。

## 页面

现有“教师与约课 / 课程日历”右侧增加“自动约课”。内部仅一个“预约设置”入口，与“运行看板”并列。看板以紧凑的一行显示状态、累计成功预约、累计检查和目标进度，老师头像标签横向切换；一次显示一位老师的全宽排班，日期纵向排列，各日的“时间＋状态”标签自然换行。排班区域原生纵向滚动，记录通过底部入口打开。不得采用多老师并排窄列、独立横向时段滚动或硬编码设计图像素样式。

设置包含收藏老师选择/排序、日期多选月历、每周时段添加/删除/排序、提前量及跨午夜休眠。排序支持拖动和前后移动按钮。空策略可保存，不能开启。负责人配置与启停，家庭成员查看。未保存修改不影响任务，保存后未发预约必须用新版本。绑定变化清理前端异步结果。

## 接口约定

插件接口沿用现有成功/错误 envelope。`GET auto-booking/config` 返回 `{revision,bindingRevision,canManage,teachers,dates,weekdaySlots,minNoticeHours,sleep}`。老师为 `{id,name,avatarUrl}`；星期键 `1` 至 `7` 对应周一至周日；sleep 为 `{enabled,start,end}`。

`PUT auto-booking/config` 接收上述可编辑字段及 `{operationId,bindingRevision,expectedRevision}`。`POST auto-booking/start` 接收 `{operationId,bindingRevision,expectedRevision}`；stop 接收 `{operationId,bindingRevision}`，幂等返回状态。

`GET auto-booking/status` 返回 `{state,phase,message,enabled,checks,totalBooked,nextCheckAt,lastCheckAt,fulfilledDates,targetDates,latestEvent,canManage}`。state 为 running/stopped/sleeping。`GET auto-booking/logs` 返回 `{items,nextCursor}`；日志项 `{id,at,kind,message,date?,teacherName?,time?}`。

`GET auto-booking/schedules?teacherId=&from=&to=&cursor=` 返回 `{teacherId,days,nextCursor,updatedAt}`，每页最多两天以遵守上游预算。day 为 `{date,state,message?,slots,target,booked}`，state 为 ready/unopened/error；slot 复用原排班字段并增加 `{matches,reason}`。分页全部完成前保留已有数据并明确显示加载，失败允许重试；不会提交预约。

## 验证

隔离验证优先级、每日限制、完整分页、取消证据、4–6 分钟、跨午夜休眠、任务停止/保存/重启、重复任务、未知结果、权限及跨账号互斥。浏览器通过原宿主加载器测试统一组件、设置、排序、标签状态保留、宽窄屏和触控。真实美森调用、任务开启及生产部署均不属于本次隔离验证。
