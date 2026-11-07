# 美森约课：接口、数据与上游适配合同

> 当前交付状态（2026-11-06，源码候选 1.0.30）：直接登录、唯一有效合约自动关联、教师/预约只读查询、收藏、持久草稿、单/多连续课时预约、两步取消及学生 PDF 已接入。真实预约/取消闭环未完成；批量顺延、预约后更换课件及 PC 原生学习协议未交付。当前证据与限制统一见 [上游核验记录](upstream-verification.md)，部署要求为插件结构 v3、前端协议 1.1，见 [部署说明](../deployment.md)。

> 2026-11-07：教师视频、学员课件 PDF 和已约课程学生 PDF 返回美森 HTTPS 直链。PDF 只允许 `https://file.mison.cn` 且路径以 `.pdf` 结尾；视频允许 `file.mison.cn` 与 `mp.mison.cn` 且路径以 `.mp4` 结尾。浏览器直接加载并使用 HTTP 缓存。宿主已删除 `resource.issue` 和 `/media/{ticket}`，不为旧插件保留中转。

> 2026-11-03：教师档案返回introVideo.inline与同源短期视频URL，新增resource.issue（purpose=teacher-intro-video）和媒体GET/HEAD流代理，支持Range。具体时段筛选改为多选，times仍采用已核验的CSV参数；日期使用共享DatePicker。视频流校验主应用身份、儿童/插件/绑定/凭据与发布版本，令牌不进入资源URL。

> 2026-11-02 历史实现记录：插件改用直接登录，`POST connection/login` 请求为 `{operationId,bindingRevision,username,password}`，成功返回下文 `Connection`，GET bootstrap读取保存的状态，DELETE connection退出。使用 `session.begin/finish/fail/get/disconnect` 私有Bridge，Token仅服务端加密保存；本机Bridge在同一Unix socket按凭证隔离控制与Bridge身份。下文 authenticate→候选课程→PUT connection 为未交付的多合约选择规划，当前前端不调用。查询缓存采用worker内有界TTL缓存（5分钟、账号与查询隔离），worker重启后旧游标明确过期。头像、PDF 和教师视频返回固定 CDN 直链，由浏览器缓存；业务接口仍不把美森 token 交给浏览器。


设计基线：1.0 / 2026-11-02，配套[实施方案](../../superpowers/plans/2026-11-02-mison-booking-implementation.md)。本文保留原设计的候选课程、多合约绑定、批量顺延及修复等规划，不能据路由表推断这些能力已交付；当前实现以本文开头的交付状态、末尾适配器补充及上游核验记录为准。“上游已记录”不代表本次已在线复测，隔离样例通过不代表真实写入验收通过。

## 1. 接口总约定

家长端业务路径前缀：

```text
/api/children/{childId}/plugins/mison-booking/runtime/
```

前端业务接口一律使用宿主`PluginContext.api(relativePath, options)`，由宿主携带平台session、CSRF与活动releaseId。不要直接调用美森业务 API，不把美森 token 交给浏览器。接口返回的头像、PDF 和视频地址由浏览器向允许的 CDN 直接加载。

GET通过query传值，数组采用逗号分隔；现有accounts_app会把query转为body传给worker，worker的path不含query。参数解析必须显式转换并拒绝未知字段。写操作仅POST/PUT/DELETE，当前SDK不支持PATCH。

```ts
type ID = string; // 上游整数ID统一转十进制字符串，禁止前端混用数字精度
type DateOnly = string; // YYYY-MM-DD，Asia/Shanghai
type LocalTime = string; // HH:mm
type ISOTime = string; // 带+08:00或Z的ISO8601绝对时间

type Result<T> =
  | { ok: true; data: T; requestId: string; serverTime: ISOTime }
  | { ok: false; error: {
      code: ErrorCode; message: string;
      retry: 'read'|'same-operation'|'reconnect'|'none';
      operationId?: string; field?: string;
      details?: Record<string, unknown>;
    }; requestId: string; serverTime: ISOTime };

type ErrorCode =
  | 'NOT_CONNECTED'|'RECONNECT_REQUIRED'|'OWNER_REQUIRED'|'NO_ELIGIBLE_CONTRACT'
  | 'BINDING_CHANGED'|'REVISION_CONFLICT'|'VALIDATION_ERROR'
  | 'SLOT_UNAVAILABLE'|'NON_CONTIGUOUS_SLOTS'|'COURSEWARE_DUPLICATE'
  | 'COURSEWARE_INVALID'|'QUOTA_EXHAUSTED'|'QUOTA_UNAVAILABLE'
  | 'UPSTREAM_UNAVAILABLE'|'UPSTREAM_REJECTED'|'UPSTREAM_SCHEMA_CHANGED'
  | 'QUERY_EXPIRED'|'DRAFT_EXPIRED'|'CONNECTION_EXPIRED'|'ACTION_UNAVAILABLE'
  | 'OPERATION_CONFLICT'|'OPERATION_IN_PROGRESS'|'RESULT_UNCERTAIN'
  | 'RESOURCE_UNAVAILABLE'|'RESOURCE_FORBIDDEN';
```

插件业务返回HTTP200的Result envelope，前端api.ts统一解包为类型化错误；平台session/资格/版本等错误仍沿用宿主HTTP错误。**美森401、50000、13000不能转成宿主HTTP401**，否则runtime会注销主项目登录。worker不能抛未捕获ValueError来表达可预期业务错误。

所有公开DTO采用字段白名单。未知上游字段不透传，错误details不能带完整响应、请求头、HTML或账号凭据。`requestId`用于审计定位，不包含用户身份。

### 1.1 写入与版本

- 表中业务写入包含UUID格式operationId和当前bindingRevision；初始从未连接时版本为0，断开后仍保持递增，不能重置为0。
- 同operationId、同规范化请求、同儿童/插件返回已记录结果，不再发上游；同ID不同请求返回OPERATION_CONFLICT。
- operationId按一次用户明确操作生成，网络失败时保留。不能在自动重试拦截器生成新ID。
- operationId有两类持久化：登录/收藏/扣额度/预约/取消/顺延/有副作用的学习入口进入外部操作日志；绑定提交/断开/草稿创建和改时段仅使用本地事务回执，不伪造外部dispatching。纯本地回执通过重放同一请求取回，不出现在OperationSummary列表。请求hash包含方法、路由和规范化输入，排除operationId自身。
- `resources/{id}/ticket`仅签发短时票据，无业务扣额，不需要operationId；`reconcile/repair`使用原operationId和stageVersion，规则见3.4。
- bindingRevision与draftRevision独立于宿主configRevision。旧绑定的教师/草稿/资源不能在新绑定下复用。
- 登录密码参与请求一致性校验时由Bridge的operation.fingerprint使用服务端HMAC，不在日志或数据库存明文或无盐散列；密钥标识随操作保存。同ID重放按原keyId计算，轮换期间仍可核对。
- 报价、余额、退款课时等缺少接口证据，不新增虚构字段。

## 2. DTO

```ts
type Connection = {
  status: 'unbound'|'connected'|'reconnect_required'|'unavailable';
  bindingRevision: number;
  maskedAccount: string | null;
  contract: null | { id: ID; name: string; courseName: string };
  canManageConnection: boolean;
  lastCheckedAt: ISOTime | null;
};
type ConnectionCandidate = {
  key: string; name: string; courseName: string;
  eligible: boolean; reason: string | null;
};
type PendingConnection = {
  pendingConnectionId: string; expiresAt: ISOTime;
  state: 'discovering'|'choose-contract';
  candidates: ConnectionCandidate[]; nextCursor: string | null;
};

type Feature = {
  mode: 'native'|'official-web'|'official-app'|'unavailable';
  reason: string | null;
};
type Bootstrap = {
  connection: Connection;
  timezone: 'Asia/Shanghai';
  serverDate: DateOnly;
  upcomingCount: number | null;
  bookingLimits: { maxContiguousLessons: number | null }; // G02核实；未知不能放开无限选择
  features: Record<'book'|'multiLesson'|'preview'|'changeCourseware'|
    'adjustOrder'|'classroom'|'replay'|'prestudy'|'homework', Feature>;
  unresolvedOperations: OperationSummary[];
};
type Label = { id: ID; name: string };
type Teacher = {
  id: ID; name: string; intro: string;
  avatarUrl: string | null; // 美森公开图片地址，仅 mp.mison.cn 或 file.mison.cn
  labels: Label[]; favorite: boolean;
  recommended: boolean; smartMatched: boolean;
  nextAvailable: null | { date: DateOnly; time: LocalTime };
  availableTimes: LocalTime[] | null;
  lessonMinutes: number | null;
};
type TeacherProfile = Teacher & {
  introVideo: Resource | null;
};
type TeacherQuery = {
  queryId: string; items: Teacher[];
  nextCursor: string | null; complete: boolean;
  total: number | null; fetchedAt: ISOTime;
};
type TeacherSchedule = {
  teacher: Teacher; date: DateOnly; timezone: 'Asia/Shanghai';
  baseDate: DateOnly;
  days: { date: DateOnly; available: boolean }[];
  lessonMinutes: number; slotStepMinutes: number;
  slots: { start: LocalTime; end: LocalTime;
    state: 'available'|'mine'|'occupied'|'unscheduled'; reason: string | null }[];
  fetchedAt: ISOTime;
};
type CategoryNode = { id: ID; name: string; isNew: boolean; children: CategoryNode[] };
type Courseware = {
  id: ID; title: string; categoryId: ID | null; categoryName: string;
  categoryPath: { id: ID; name: string }[];
  learned: boolean | null; active: boolean;
  selectedElsewhere: boolean; isNew: boolean;
  previewAvailable: boolean; unavailableReason: string | null;
};
type Quota = { remaining: number; total: number; fetchedAt: ISOTime };
type Draft = {
  id: string; revision: number; bindingRevision: number;
  teacher: Pick<Teacher,'id'|'name'|'avatarUrl'>;
  date: DateOnly; timezone: 'Asia/Shanghai';
  lastLearned: Pick<Courseware,'id'|'title'|'categoryName'> | null;
  lessons: { start: LocalTime; end: LocalTime;
    courseware: Courseware | null; origin: 'recommended'|'manual'|'unlearned';
    selectionReceipt: string | null }[];
  quota: Quota | null; hasUnlearned: boolean;
  valid: boolean; issues: { code: string; slotStart?: LocalTime; message: string }[];
  expiresAt: ISOTime | null; // 当前草稿不设固定有效期，返回null
};

type CourseAction = {
  allowed: boolean; mode: Feature['mode']; reason: string | null;
};
type Booking = {
  key: string; // 插件生成的稳定标识；不要求已取消记录有cid
  cid: ID | null; teacher: { id: ID | null; name: string; avatarUrl: string | null };
  courseware: Pick<Courseware,'id'|'title'|'categoryName'> | null;
  status: 'upcoming'|'completed'|'cancelled';
  startsAt: ISOTime | null; endsAt: ISOTime | null; timeLabel: string;
  upstreamStatusLabel: string | null;
  homeworkState: 'finished'|'unfinished'|'unknown';
  snapshotVersion: string;
  actions: Record<'cancel'|'adjustOrder'|'materials'|'prestudy'|'homework'|'classroom'|'replay', CourseAction>;
};
type BookingQuery = {
  queryId: string; state: 'building'|'ready';
  items: Booking[]; nextCursor: string | null; total: number | null;
  sourceComplete: boolean; fetchedAt: ISOTime;
};
type Resource = {
  id: string; kind: 'avatar'|'intro-video'|'courseware-preview'|'handout'|
    'exercise'|'prestudy'|'homework'|'classroom'|'replay';
  title: string; action: 'inline'|'download'|'external'|'instructions'|'unavailable';
  url: string | null; mimeType: string | null; filename: string | null;
  expiresAt: ISOTime | null; instructions: string | null; reason: string | null;
};
type OperationState = 'prepared'|'dispatching'|'succeeded'|'failed'|
  'uncertain'|'partially_succeeded'|'needs_repair'|'cancelled';
type OperationSummary = {
  operationId: string; kind: 'connect'|'favorite'|'preview'|'change-courseware'|
    'book'|'cancel'|'adjust-order'|'open-resource';
  state: OperationState; stage: string; message: string;
  createdAt: ISOTime; updatedAt: ISOTime;
};
type Operation = OperationSummary & {
  bindingRevision: number; stageVersion: number;
  result: null | { bookingKeys?: string[]; pendingRecordSync?: boolean;
    resource?: Resource; draft?: Draft; quota?: Quota;
    pendingConnection?: PendingConnection;
    favorite?: { teacherId: ID; favorite: boolean };
    bookingSummary?: { teacherId: ID; teacherName: string; date: DateOnly;
      lessons: { start: LocalTime; end: LocalTime; coursewareId: ID; title: string }[];
      confirmedLessonCount: number; consumedLessonCount: number | null };
    succeededSlots?: LocalTime[]; unresolvedSlots?: LocalTime[] };
  canReconcile: boolean; canRepair: boolean; canRetryOriginal: boolean;
};
```

DTO里nullable值必须实际返回null，不能用空字符串/0冒充未知。没有verified learned字段时用null，“本次已选”不能误渲染成“学过”。Booking.teacher.id无法可靠识别时返回null，保留可读姓名，不能用于教师详情/预约API；Teacher列表的id仍必须是真实ID。预约成功视图从持久bookingSummary恢复；consumedLessonCount仅在上游整组明确成功且G02确认按选中课时消费时填写，否则null，不能在部分成功时宣称整组已扣额。

Operation.result按kind有确定必需字段：connect成功带pendingConnection；favorite成功带favorite；preview成功带resource（直接学员PDF，无quota依赖）；change-draft成功带draft；book带bookingSummary、bookingKeys、pendingRecordSync；cancel/adjust-order带受影响bookingKeys；open-resource带resource。无对应证据时保留null或未决state，不构造成功字段。非终态可有已完成部分的result；终态业务拒绝用message解释，不使用canRetryOriginal绕过未知结果。

canRetryOriginal仅表示“用户可重新发起这类业务”，只在明确未生效且条件可重试时为true，点击后生成新UUID；它不是允许再次发送原ID。错误retry=same-operation表示取回相同请求的持久回执，不能让已终结操作重新执行。未知、部分成功、待修复状态一律不能重试原业务。

## 3. 前端业务接口清单

默认集合pageSize=20；教师上游推荐分页limit=10。pageSize允许1–50，超限拒绝；cursor为服务端生成、绑定查询与账号版本的opaque值，不能由前端拼上游页号。

### 3.1 启动与连接

| 方法 / 相对路径 | 输入 | 返回data / 行为 |
|---|---|---|
| GET `bootstrap` | 无 | Bootstrap；未连接仍能调用，返回权限和连接状态 |
| POST `connection/authenticate` | `{operationId,bindingRevision,username,password}` | PendingConnection；只登录一次，临时token留服务端 |
| GET `connection/candidates` | `pendingConnectionId,cursor?` | PendingConnection；复用候选token，不再login |
| PUT `connection` | `{operationId,bindingRevision,pendingConnectionId,candidateKey}` | Connection；负责人、候选归属/TTL检查，CAS换绑并撤销旧票据 |
| DELETE `connection` | `{operationId,bindingRevision}` | Connection(unbound)；删除活动/候选凭据，递增版本，清缓存，不取消课程 |

重连复用authenticate→PUT流程，登录失败不立即覆盖原令牌。候选会话只允许原负责人和当前儿童访问，10分钟过期；过期后清理加密候选，必须重新发起连接。登录账号长度1–128，密码长度1–256；不在浏览器保存。

密码交换成功后，先credential.stage持久化加密候选，再发发现请求；发现失败返回成功envelope内state=discovering的PendingConnection（candidates可空），前端继续GET发现，不再login。登录操作成功只表示取得候选会话，尚未替换活动绑定。

authenticate发送后发生结果不明时，返回`ok:false,code:RESULT_UNCERTAIN,retry:none,operationId`，记录connect操作为uncertain；已知账号密码错误则UPSTREAM_REJECTED且操作failed。前端通过GET operations查询；结果有pendingConnection可恢复，令牌未收到则无法找回，只允许用户重新明确输入密码创建新登录操作，不自动重发login。已成功但候选已过10分钟的重放返回CONNECTION_EXPIRED，不能重新login。

connect操作及候选仅当前负责人可读，不向普通成员返回；未绑定时允许当前儿童/插件作用域的连接操作查询。成功绑定后该connect记录作为历史回执，不把旧bindingRevision=0的记录继续当未决。登录前还不知道userid时，以服务端HMAC(provider+规范化账号)作为临时登录锁键；登录确认后保存真实userid指纹。未知登录不会永久挡住用户的下一次明确重连，但必须先释放执行租约，仍保留未知终端占用的记录。

PUT/DELETE connection必须使用实施方案的binding.commit/disconnect一次事务完成。客户端重放旧expected revision时先检查幂等回执，再确认结果绑定仍为当前版本；不能先删除旧token再尝试写新绑定。正在发送的写入只允许记录到旧绑定日志，不能更新新绑定课程。

### 3.2 教师、收藏与档期

| 方法 / 路径 | 输入 | 返回data |
|---|---|---|
| GET `teacher-filters` | 无 | `{labelGroups:[{id,name,labels:Label[]}],timeSlots:LocalTime[],timezone}` |
| GET `teachers` | `nickname?,date?,times?,labelIds?,favoritesOnly?,cursor?` | TeacherQuery |
| GET `teachers/{teacherId}` | 无 | TeacherProfile |
| GET `teachers/{teacherId}/schedule` | `date?` | TeacherSchedule；无date选择首个可约日；整个窗口无可约时返回days和空slots |
| PUT `teachers/{teacherId}/favorite` | `{operationId,bindingRevision,favorite:boolean}` | `{teacherId,favorite}` |

收藏请求表达目标状态，不是盲目toggle。普通搜索传`ddate:''`表示不限日期。浏览器仅传teacherId和筛选条件；userid/user1v1_id/t_type等从服务端绑定及核验配置取得。

收藏成功返回表中的简洁对象，底层仍记favorite操作。发送后未知返回RESULT_UNCERTAIN及operationId，前端先查询/核对Operation，不生成新操作反向切换。任何返回非Operation的写入都使用相同错误约定暴露已发送操作，不能只返回“网络错误”丢失核对入口。

**完整查询规则：**

- 非收藏：第1页返回普通池+推荐第1页；后续只追加去重后的推荐池。总数未知时null，smart_count变化不作为稳定快照承诺。以G06核验的终止条件标complete=true；连续两页未产生新tid但终止条件未满足，返回UPSTREAM_SCHEMA_CHANGED并保留已见结果，不能伪装完整结束或死循环。
- 收藏且没有日期/时段：读取getTeacherCollect完整收藏，再在服务端按昵称与标签ID筛选；以报告字段核验标签AND，缺失标签不能按名字猜匹配。
- 收藏叠加日期/时段：用相同搜索条件扫描完整普通/推荐池与收藏集合求交；每请求最多3个源页，未扫描完返回nextCursor和complete=false，即使本页items为空也显示“继续查找”，不下结论为空。
- 教师列表分页不设固定有效期，按childId、bindingRevision和规范化筛选单独保存；课程日历和课件分页不能使该游标失效。筛选或绑定变化后旧游标失效。取消收藏后使相关查询失效并重建，不能继续拼接旧快照。
- 资料缓存5分钟，档期缓存30秒，提交前强制新读；收藏/预约/取消成功使相关cache失效。

### 3.3 草稿与课件

| 方法 / 路径 | 输入 | 返回data / 行为 |
|---|---|---|
| POST `drafts` | `{operationId,bindingRevision,teacherId,date,slotStarts:LocalTime[]}` | Draft；重新验证可约且连续，建立无固定有效期的服务端草稿并请求推荐 |
| GET `drafts/{draftId}` | 无 | Draft；验证当前绑定，不设固定TTL；兼容旧草稿过期标记 |
| PUT `drafts/{draftId}/slots` | `{operationId,bindingRevision,expectedRevision,slotStarts}` | Draft；仅同老师同日；按start保留手选课程，新增位置补推荐 |
| GET `courseware/categories` | 无 | `{nodes:CategoryNode[],depthNames:string[]}` |
| GET `courseware` | `categoryId,draftId,slotStart,cursor?` | `{items:Courseware[],nextCursor,total}`；只接叶子分类 |
| GET `courseware/unlearned` | `draftId,slotStart,cursor?` | 同上；来源为取消/作废关联的待补学列表 |
| GET `courseware/quota` | 无 | Quota |
| POST `courseware/{coursewareId}/preview` | `{operationId,bindingRevision,draftId,expectedRevision,slotStart}` | Operation；从当前草稿的 `student_file_url` 返回学员 PDF 直链，不调用扣额接口，不受Quota限制 |
| PUT `drafts/{draftId}/lessons/{slotStart}/courseware` | `{operationId,bindingRevision,expectedRevision,coursewareId,source:'category'\|'unlearned'}` | Operation(result.draft)；验证可选/去重，只修改草稿，不消耗额度 |

草稿的推荐课件和manual selectionReceipt只在服务端签发。selectionReceipt绑定draftId、revision、slotStart、coursewareId、bindingRevision，不可跨草稿复用。它记录已经执行的选课流程，不能允许客户端自报“已扣额度”。

草稿每次revision变化时，服务端按保留的合法选择证据重新签发对应receipt；移除的时段销毁对应receipt。预约dispatching期间草稿冻结；其他页面修改返回OPERATION_IN_PROGRESS。当前草稿不设固定TTL，旧草稿过期标记通过显式兼容读取处理；提交仍校验当前绑定、修订、课件及真实档期，不能用旧revision自动提交预约。

打开更换器、展开分类和分页都是只读；关闭不扣额。预约前选择/更换课件只更新持久草稿，不发送扣额请求。预约后已排课程的更换属于另一操作，当前未开放；不能混用其接口或计数规则。

预览只使用当前授权草稿中美森返回的学员PDF地址，不接受浏览器传入任意URL，也不访问教师文件。失败不回退到官方扣额接口；资源票据过期可重新签发。保留旧版操作回执的只读查询，历史未决扣额操作不得自动重发。

### 3.4 预约、取消与顺延

| 方法 / 路径 | 输入 | 返回data / 行为 |
|---|---|---|
| POST `bookings` | `{operationId,bindingRevision,draftId,expectedRevision}` | Operation；不接受浏览器直接给userid/合约/课件数组替代服务端草稿 |
| GET `bookings` | `status:'upcoming'\|'completed'\|'cancelled',from?,to?,cursor?,pageSize?` | BookingQuery；旧全量扫描，日历和预约弹窗不再使用 |
| GET `bookings/pages` | `status,page` | 恰好一个上游页，最多100条，保留上游顺序；`complete` 表示该状态已到末页 |
| POST `bookings/{bookingKey}/cancel` | `{operationId,bindingRevision,snapshotVersion,adjustLessons:boolean}` | Operation；验证该课节属于当前账号/合约、未完成、可取消 |
| POST `bookings/adjust-order` | `{operationId,bindingRevision,items:[{bookingKey,snapshotVersion}]}` | Operation；至少1项最多50项、无重复，先获取全部新状态再调用已核验接口 |
| GET `operations/{operationId}` | 无 | Operation；仅当前儿童、插件、绑定可读 |
| POST `operations/{operationId}/reconcile` | `{bindingRevision,expectedStageVersion}` | Operation；只读上游核对，不重复原业务调用 |
| POST `operations/{operationId}/repair` | `{bindingRevision,expectedStageVersion}` | Operation；仅已确认可安全补偿的阶段；使用原记录保存的cid/adjustLessons |

`reconcile/repair`属于原操作状态转换，不生成另一个原始预约或取消operationId。重放同stageVersion时返回已推进状态；不能把“修复记录”解释成重新取消/重新顺延。

**列表完整性和排序：**

日历与「我的预约」共用 `GET bookings/pages`。每次只读取一个上游页，不按月份缓存，也不把已上课和待上课合成一次请求。2026-11-06 只读复测：待上课 `getLiveList` 从近到远，已上课 `getBackList`（必须带 `is_lesson_status=1`）和已取消 `onevoneGetCancelLesson` 从新到旧；超出末页返回空列表。页内顺序不符合时返回 `UPSTREAM_SCHEMA_CHANGED`，前端不把残缺结果当成完整课程。待上课通常不超过一页；只有接口明确还有下一页，且画面碰到已加载的最晚一天，才继续向后取。已上课和已取消只在画面碰到已加载的最早一天或更早时继续取，同一天可能拆页，所以边界当天也要继续确认。已取消没有 `cid` 和总数字段，短页即结束，也不能按上课时间并入其他状态。成功预约只清待上课，成功取消清待上课和已取消；关闭弹窗不刷新日历。课程同步仍自行全量扫描，不读这份页面缓存。

旧 `GET bookings` 仍保留全量扫描。

上游没有记录通用日期过滤与稳定排序参数。后端建立短期查询快照：每个请求最多扫描3个上游页（每页100），保留nextCursor；需要全局排序/日期过滤时，未扫描完返回state=building、items=[]、total=null，前端显示加载进度并继续请求。扫描完后在服务端归一化、过滤、全局排序，再按20条分页，快照TTL5分钟。不采用“只筛当前页”冒充全局日期过滤。

典型少量预约一个源页即ready。历史很多时逐步加载，不用`page_size=10000`突破响应和内存预算；未完成/失败都不得显示空结果。数据量超出配置的查询上限时返回明确UPSTREAM_UNAVAILABLE说明查询过大，不截断后宣称完整。实现查询上限为5000条、快照总大小8MiB；可在后续经评估增大，第一版不对超量历史提供不准确结果。

快照使用实施方案的query_meta+query_chunks分片存储，每条≤64KiB；前端每页仅取20条，序列化响应总计≤900KiB，超过单次预算继续cursor而非发超大JSON。缓存中保存稳定资源引用，不把5分钟票据当长期头像URL；组装每页DTO时按当前权限签发新票据。from/to为北京时间上课日期闭区间，校验from≤to；状态/筛选变化使旧cursor失效。

已取消记录没有cid：key使用可信`bid/courseid/courseware_id/dateTime`组合的hash；缺失时加原始稳定内容hash，不能用列表序号。没有稳定唯一性时展示记录但不可执行任何写动作。

### 3.5 课程资料与学习入口

| 方法 / 路径 | 输入 | 返回data |
|---|---|---|
| GET `bookings/{bookingKey}/resources` | 无 | `{items:Resource[]}`；只读元数据，无观看登记或额度消耗 |
| POST `bookings/{bookingKey}/actions/{kind}` | `{operationId,bindingRevision,snapshotVersion}`，kind为prestudy/homework/classroom/replay | Operation(result.resource)；有上游副作用时纳入日志 |
| POST `resources/{resourceId}/ticket` | — | 已删除。不再刷新同源票据 |

resourceId是服务端解析后的资源引用，不接受用户直接提交URL。对于已完成的课件预览、资料下载、教师视频，通过该引用签发票据；打开资料不能自动调用具有扣额语义的预览接口。

PDF 与视频不再经过宿主代理。插件只接受固定 HTTPS 主机和扩展名，前端再次校验后才写入播放器或 PDF.js。`mp.mison.cn` 不用于 PDF。官方外部学习 URL 仍按 G05 的精确规则单独审核，不能借用这两个 CDN 主机绕过课堂身份要求。

`action=external`只返回经证实的官方HTTPS地址，不带插件持久JWT；若官方协议必须用短时一次性票据，只返回该票据和准确TTL，并验证不会泄漏长期token。无可用PC协议则`action=instructions`，显示准确的App页面路径。`action=unavailable`给出具体原因，不能用一段成功Toast替代入口。

## 4. 上游接口映射

主机A：`https://mp.mison.cn/wechatapi/`，JSON成功条件`code == 200`。
主机B：`https://api.mison.cn/v2/`，JSON成功条件`status == 0`。
除登录外使用`Authorization: Bearer <JWT>`。HTTP200不等于业务成功；HTML不能交给前端执行或作为成功数据。

worker HTTP client仅调用以上两个固定origin与适配器登记的路径，TLS验证开启；业务API默认拒绝重定向，不能将Bearer跟随302发到其他域名。上游JSON响应读取上限2MiB，超量返回明确结构/容量错误；流式读每一段均受同一35秒绝对deadline约束，重试、阶段切换不能重置截止时间。公开DTO仍受900KiB单次响应预算约束。PDF 和视频字节不进入插件响应。

下表中的标识值必须来自当前绑定；原报告样本ID不是配置默认值。

| 前端能力 | 上游 / 方法 | 主要入参 | 归一化与注意事项 |
|---|---|---|---|
| 登录 | B `member/login` POST | username,password | 外层status=0；检查data.token及内层状态，禁止整包回传 |
| 课程识别 | B `course/myOneToOneList`、`myCourseList` | 当前账号 | 已动态关联合约/课程班/课件树ID，仅接受唯一有效关联；myCourseDetail不是当前识别必需调用 |
| 教师标签 | A `getTeacherLabelGroups` POST | {} | category_id/name/list，动态渲染标签，不硬编码15项 |
| 时间模板 | A `onevoneTimeTemplateV2` POST | {} | data[]时间字符串；时段步长据模板验证 |
| 教师搜索 | A `onevoneSearchTeacher` POST | t_type=核验值,ddate,dtime,nickname,can_date=1,user1v1_id,label_id,page,limit=10 | 普通池重复、推荐池分页；is_smart_matching分组 |
| 收藏列表 | A `getTeacherCollect` POST | userid | data[],count；ID取tid，头像headerUrl/headerUrl2 |
| 收藏开关 | A `teacherCollect` POST | tid,status=1/0 | 不盲目切换，目标状态写入后确认 |
| 可约日 | A `onevoneGetDaysAvailable` POST | tid,userid | 数组下标相对服务器北京时间当天；返回时附baseDate |
| 档期 | A `onevoneGetTeacherInfo` POST | tid,userid,ddate | all_date；-1无排班、0可约、正数本人/他人占用 |
| 推荐 | A `getRecommendCourseware` POST | user1v1_id,userid,count=课时数 | lastCourse、list；顺序与课时按开始时间一一对应 |
| 分类树 | A `getCoursewareCategoryTree` POST | liveid=绑定识别值 | 任意深度tree；5911只是样本，来源见G01 |
| 课件列表 | A `getCoursewareList` POST | category_id,page,limit,user1v1_id,splitPage=1 | id/title/category/choosed；学过标记来源需G07确认 |
| 额度 | A `onevoneGetChangeCoursewareTimes` POST | userid,user1v1_id | leftTimes/allTimes；不可用≠0额度 |
| 待补学 | A `onevoneGetCancelCourseware` POST | user1v1_id,userid,page,limit | 非空结构与“作废”具体语义见G07 |
| 预览 | 草稿中的 `student_file_url` | 不调用扣额接口 | 直接打开学员 PDF；官方扣额接口见 G03，本插件不再使用 |
| 预约前确认更换 | 插件本地草稿事务 | 草稿目标课件及绑定/修订 | 不调用上游更换或扣额接口；预约后更换未开放 |
| 预约 | A `onevoneAppointment` POST | tid,userid,ddate,dtime,user1v1_id,lesson_period,courseware_id | 多课时courseware_id编码见G02；成功无cid |
| 待上课 | B `course/getLiveList` POST | classid=课程班ID,page_size,page_no,courseway=0,blockid=0 | data.list及分页元数据；与1v1合约ID区别 |
| 已上课 | B `course/getBackList` POST | 同上,is_lesson_status=1 | 显示真实学习/作业状态；回放地址需解析协议 |
| 已取消 | A `onevoneGetCancelLesson` POST | userid,classid=1v1合约ID,page,limit | dateTime可能已含区间，无cid不能拿courseid代替 |
| 取消步骤1 | A `cancelLesson` POST | userid,cid | code=200且data.status=1；msg可能只是“获取成功” |
| 取消步骤2 | A `onevoneSaveCancelLesson` POST | cid,status=1,userid,adjust_lessons=0/1 | 步骤1成功后才调用；顺延副作用单独核验 |
| 批量顺延 | G04定位 | G04核验 | 报告只记录UI及资格，没有完整端点/排序算法 |
| 学生PDF资料 | B `course/courseClassResource` → `download/pdf` | lessonid,type,cid,producttype → fid | 已接通学生PDF；上课/回放/预习/作业仍返回App操作说明 |
| 教师视频 | GET data.intro_video | 不带Bearer | 返回允许的 MP4 直链，禁止猜tno+姓名拼文件名 |

**字段细节：**

- Teacher.name取name，再nickname；HTML简介转换为纯文本，禁止dangerouslySetInnerHTML。
- 日期、昵称、标签和用户ID不从样本复制。`t_type=2`是报告样本的教师类型，作为适配器经G01确认的合约属性；不同类型合约不自动套用。
- `lessonTime`可能为“25分钟/课时”，只接受可解析且合理的正整数；无法解析返回结构变化错误，不能静默固定25分钟。
- `is_dated>0`只在服务端与当前userid比较，归一化后不回传占用者ID。
- 课件学生文件、讲义、练习文件可以构建Resource；教师文件不提供。
- `getLiveList`的datestart/dateend和取消列表dateTime分别解析，统一带时区ISO；无法解析保留timeLabel，但禁用需要时间判断的写操作。
- quota与收藏属于上游账号，而非本地家长。推荐仍以上游接口为准，不自行`sort+1`推导下一课。

## 5. 账号与会话编排

```text
unbound
  └─ 负责人authenticate → pending token（10分钟）
       ├─ 有候选 → 负责人确认candidate → connected（bindingRevision+1）
       ├─ 发现失败 → 保留pending，重试发现，不重login
       └─ 无合约/过期 → 解释原因，重新发起连接
connected
  ├─ 业务读取成功 → 复用当前token
  ├─ 401 / 50000 / 13000 → reconnect_required
  ├─ 5xx/超时 → 临时unavailable，保留token
  └─ 负责人disconnect → unbound（bindingRevision+1）
```

报告说明token约30天、每次login占一个终端位、无refresh_token。本方案不存密码，所以不执行“到期前7天自动重登”；不复制文档中的早期自动续期伪代码。失效后由负责人输入密码重连。

调用轻量wechat接口成功不足以证明会话仍有效：报告表明被淘汰token可能在mp侧仍可用，而B端已返回13000。连接核验须包含B端课程读取；不要用getTeacherCollect单独作为会话有效结论。

pending/活动凭据原子替换后使旧query、draft、resource票据失效。pending候选唯一标识只映射服务端查到的完整元组，浏览器不得任意设置`userid/user1v1_id/classid/liveid`。

同一账号多儿童绑定的数据行为见实施方案；写锁使用SHA256(provider+userid)得到remote_fingerprint，不采用phone明文。每个绑定有独立授权token引用，本地响应不能跨儿童缓存复用。

## 6. 外部写操作与一致性

### 6.1 发送前登记

现有平台`plugin_operations`是内部操作重放，`effects`是返回后持久化，都不能证明外部请求尚未发送。新`plugin_external_operations`须在HTTP请求之前创建。

```python
def run_external_write(ctx, request, bridge, send, normalize):
    op = bridge.begin_operation(ctx, request)  # CAS、请求hash、账号锁与资源冲突检查
    if not op['mayExecute']:
        return op['publicOperation']
    validate_current_upstream_state()          # 只读刷新，失败时尚未发送
    permit = bridge.mark_dispatch(ctx, op['id']) # 检查资格/绑定/锁，落库dispatching
    try:
        raw = send(deadline=permit['deadline']) # 一次发送；禁用自动POST重试
    except TransportOutcomeUnknown:
        return bridge.finish(permit, state='uncertain')
    result = normalize(raw)
    return bridge.finish(permit, **result)
```

这段为编排伪代码，接口实现位置是插件operations.py与SDK BridgeClient；`validate_current_upstream_state`按预约/取消/顺延分别实现，不能不验证就调用通用函数。

`prepared`未发送且明确失败可以安全结束。`dispatching`之后遇到超时、断线、进程崩溃，一律uncertain，不能改成普通失败重新发送。HTTP4xx/5xx只有在证据证明未执行业务时才可判failed；上游代理HTML/500不足以推断无副作用。

同账号当前dispatching由数据库租约串行；租约60秒，高于35秒业务截止时间。租约失效将操作转uncertain，不直接把它当成从未发送。未决操作资源键至少包括：预约的账号/date/start及teacher/date/start集合、取消的cid、顺延的cid集合、课件额度的remote账号。按账号时段同时拦截不同教师的重叠预约，不能只锁某位教师。新操作命中未决资源返回RESULT_UNCERTAIN，引导核对，不允许换operationId绕过。

book已明确成功但pendingRecordSync=true时，同样保留时段占用屏障，直到getLiveList同步确认；不能因为state=succeeded就让新operation绕过上游短暂延迟。跨家长竞争时，第二个请求在取得账号租约后重新读档期并检查持久占用屏障，不能使用排队前的校验结果。明确取消成功后才按真实课节清理对应占用。

新写请求先核对bindingRevision及活跃凭据；陈旧前端一律BINDING_CHANGED。写完成后清理相关只读缓存。跨系统无法提供原子回滚：停用只能阻止新的调用，已被美森接受的操作可能完成。

### 6.2 预约核对

提交前保存baseline：当前待上课中匹配所选日期、教师与时段的课节ID集合，和本次请求的课件映射。验证没有已有本人课程或占用冲突。

成功`code=200`但data无cid：先记succeeded与pendingRecordSync=true，再回读getLiveList。优先用teacherId+北京时间开始+coursewareId匹配，必须排除baseline中的旧课节。teacherId缺失才用规范化姓名作为辅助，并要求唯一匹配；禁止凭名字单独匹配。

发生uncertain：只读核对三个时间点（立即、用户页面仍打开时约2秒后、约5秒后）；仅重读，不重发。全部唯一匹配可确认成功；一部分匹配记partially_succeeded并逐项显示；没有匹配继续uncertain，因为上游可能延迟。不自动取消已成功课程，也不补约剩余课程。

用户刷新后按保存的operationId读取状态。若进程在上游成功后、记录结果前被杀，不能依赖内存“已提交”变量；操作日志与baseline用于恢复。

### 6.3 两阶段取消

阶段名固定：`validate → cancel_sent → cancel_confirmed → marker_sent → completed`。

1. 验证cid当前归属、状态、snapshotVersion；保留原课件/老师/时段。
2. `cancelLesson`返回code=200且data.status=1后记录cancel_confirmed。
3. 调`onevoneSaveCancelLesson`，成功记succeeded。
4. 第一步明确成功、第二步明确失败：needs_repair，UI“课程已取消，取消记录保存未完成”。修复仅执行第二步。
5. 第一步结果未知：uncertain，不发送第二步；通过上游预约/取消/档期综合核对，记录缺失不能直接当成取消成功。
6. 第二步结果未知且adjust_lessons=1：可能已经顺延，不能自动重放。G04必须核验重复调用是否幂等或可读出可靠效果；未证实前只允许核对，不开放repair。
7. adjust_lessons=0也不能无条件假定重复标记安全；明确业务拒绝可修复，网络未知须先核对。

取消修复使用原操作保存的cid和选项，不让浏览器改变adjustLessons。被移出儿童的家长不能修复；资格重新恢复后由当前合法成员核对同绑定旧操作，新的权限上下文不复活旧worker。

### 6.4 收藏、预览、更换、顺延

- 收藏写的是目标状态，未知结果先getTeacherCollect核对，再决定是否已经完成，不连点toggle。
- 当前预览从草稿学员 PDF 签发资源，预约前更换只修改草稿，两者均不消耗预览额度，也不依赖额度查询。仍校验operationId、绑定和修订；历史扣额操作只读核对，不能通过重试重新派发扣额请求。
- 批量顺延先保存课节和课件快照，调用后回读映射；不知道变更算法不能用本地数组重排假装成功。G04未解决重复语义时网络未知一律人工核对。
- 同一operationId不同类型/不同课件/不同cid必须冲突。业务消息给具体动作，不向用户显示数据库锁/字段名等实现内容。

## 7. 必须完成的上游核验任务

以下为最初识别的核验问题目录，当前已解决部分及剩余边界见 [上游核验记录](upstream-verification.md)；不能把本表重复当作“全部未实现”的现状。没有证据就不能把相应真实功能标为完成。先读已有报告、非临时项目的抓包和APK；真实写入必须有明确指定的测试账号/课程和操作范围。

| 编号 | 缺口 | 核验动作 | 完成证据与实现分支 |
|---|---|---|---|
| G01 | 登录后如何得到课程classid、user1v1_id、liveid、教师类型 | 检查myOneToOneList/myCourseList/myCourseDetail调用链和样本；核对多合约、无效合约 | 每个候选能得到完整ID元组及显示名；无默认样本ID。若liveid是产品固定值，需要静态证据及适用产品条件 |
| G02 | 多课时courseware_id编码、最大课时数、部分成功 | 提取App两课时确认提交的实际payload与处理分支，核对1/2/超过2、最后一档 | 文档写明是CSV/数组/其他真实格式及限制；fixture包括多课时，适配器不猜。上游无原生批量时先报告证据，不擅自拆单改变语义 |
| G03 | 区分官方扣额预览、预约前选课件和预约后更换 | 对照App调用链及当前课件列表的student_file_url；核对资源授权、来源与失败路径 | 当前使用草稿中学员PDF、选择只改草稿；不调用或回退到扣额接口。预约后更换单独核验，不能混用协议 |
| G04 | 批量排序端点、选中顺序、取消顺延作用及重复安全性 | 阅读批量排序/adjust_lessons调用点；在授权样本上比较操作前后cid→courseware映射 | 端点/参数/资格/结果/幂等性逐项记录；解释是否只改内容与影响未选课节范围，确认文案据此准确说明 |
| G05 | 上课、回放、预习、作业、下载完整链路与PC支持 | 检查haveClass、courseClassResource及相关页面处理；只读查询真实返回结构 | 每类动作有可验证PC URL/资源或官方App路径；不得从ID猜URL。识别短时票据与长期JWT，后者不得泄露 |
| G06 | 列表状态、排序、分页、日期区间与总数可信度 | 读取预约/已上/已取消分页样本，验证page_no/page、allRow/count及重复边界 | adapter准确读分页终止条件与status字段；本合同全局排序/过滤无需依赖未知上游sort参数 |
| G07 | 作废/待补学非空字段、学过标记、失效课程规则 | 读非空样本与App渲染判断；不把choosed当learned | 非空fixture、learned准确来源、active判断、作废后允许路径；缺字段时nullable而非伪造 |

每项记录四种证据等级：`文档已有`、`静态调用链确认`、`只读接口复核`、`授权写入闭环`。仅文档已有不能声称这次实时验证。所有样本标注采样日期和账号类型，排除与试听课混用。

## 8. 错误与前端响应矩阵

| 条件 | 合同状态 | UI行为 |
|---|---|---|
| 未绑定 | NOT_CONNECTED | 连接卡，不请求教师/课件 |
| 账号被挤下线/过期 | RECONNECT_REQUIRED | 连接条提示重新连接；保留当前会话草稿但禁写，不登出主站 |
| 读取超时/HTML错误 | UPSTREAM_UNAVAILABLE | 保留旧数据并标注未刷新，局部重试 |
| 对象归属或权限不符 | OWNER_REQUIRED / RESOURCE_FORBIDDEN | 不继续执行，显示具体动作不可用 |
| 草稿/绑定修订变更 | REVISION_CONFLICT / BINDING_CHANGED | 重新读取，不静默覆盖其他家长 |
| 时段失效 | SLOT_UNAVAILABLE | 列出失效时段，回到档期；保留仍有效课件映射 |
| 非连续 | NON_CONTIGUOUS_SLOTS | 本地与服务端都拦截，不发送预约 |
| 同课件重复 | COURSEWARE_DUPLICATE | 标记具体课时与课件，禁提交 |
| 额度0/未知 | 仅历史扣额接口/记录使用Quota错误 | 当前学员PDF预览、草稿更换和预约不受预览额度限制；资源无效时显示具体文件错误 |
| 上游明确业务拒绝 | UPSTREAM_REJECTED | 显示净化后的可读原因，按钮恢复，保留输入 |
| 写入可能已生效 | Operation.uncertain | 显示“结果待核对”，只提供核对，不重复提交 |
| 取消记录失败 | Operation.needs_repair | 明确实际已取消；安全时提供补全记录 |
| 部分课时成功 | Operation.partially_succeeded | 逐时段列状态，不能用一个“成功”笼统盖过 |
| 不支持PC学习动作 | Resource.instructions | 官方App使用路径；不出现假播放/假作业页面 |
| 平台停用/下架/版本变化 | 宿主已有错误 | 卸载插件页面/回平台占位态，不向旧绑定继续发送 |

## 9. 适配器测试要求

上游HTTP client必须可注入transport与clock。各纯函数归一化测试不联网；业务测试同时断言响应、持久操作阶段、HTTP调用次数与请求体。

- 两种成功envelope与所有认证失败码；HTTP200错误/非JSON/超长响应。
- 日期模板17项以实际长度渲染，午夜重读baseDate；时长25、步长30的区别。
- 普通池重复3页、推荐池变化、收藏只在第3页出现、途中空页但未结束。
- draft revision、无固定TTL及旧TTL兼容、重复课件、推荐不足、classid两种含义不串用。
- 原生两课时真实编码fixture；超出上游限制提前拒绝。
- 学员PDF缺失/来源不支持、同操作重复点击、零额度下选择/预览/预约、历史扣额回执只读恢复。
- 预约成功无cid、响应丢失、旧预约同时间匹配歧义、部分课时成功。
- 两阶段取消第二步失败、第二步已顺延后断线、再次repair不重复顺延。
- 不再提供媒体票据。直链必须是允许的 HTTPS 主机和扩展名；不受支持的地址拒绝，不回退到宿主代理。
- 平台核心登录未被美森鉴权失败影响；浏览器存储/公开DTO/日志不含凭据。

**完成定义：** 接口契约、前端真实请求、独立worker、平台Bridge与数据库状态在隔离集成中贯通；G01–G07有可审查证据。未支持的PC学习动作只能以经验证的官方入口回退交付，不能以“后端以后再接”结束任务。


## 当前适配器补充（始于2026-11-03，随源码更新）

以下以本次App定点静态代码及真实只读响应核验为准，覆盖前文仍待G02/G03核验的部分：

- G01：`read_api.contracts` 使用 myOneToOneList 与 myCourseList 关联 id/courseid/gradeid 和 liveid/classid/new_liveid，仅接受唯一有效合约；样本ID不作为默认值。当前适配的一对一产品使用 teacherType=2，多合约选择仍未交付。

- G02：App预约函数按时段顺序取每课时选中的id，`courseware_id = ids.join(",")`、`lesson_period = 数量`、`dtime = 第一个时段`，一次调用onevoneAppointment。生产写入未实约；隔离合成上游验证了实际序列化协议及响应丢失核对。
- G03：预约前选课件只更新App本地选择数组，没有独立扣额调用。美森 App 的预览会调用 onevonePreviewCourseware 并扣 leftTimes；本插件已改为直接使用课件列表里的 student_file_url，不再调用该扣额接口。预约后已排课程的 onevoneChangeCourseware 是另一操作，本次不混用。
- 现有PUT drafts/{id}/lessons/{start}/courseware保持前端Operation返回形状，但kind=change-draft，只持久修改草稿，quota0不阻止选择/预约。新增source=unlearned查询onevoneGetCancelCourseware，未凭空推导learned。
- 草稿GET drafts/{id}、POST drafts、PUT drafts/{id}/slots已实现，不设固定TTL，expiresAt返回null，公开revision与内部CAS修订分离。旧草稿通过私有Bridge的includeExpired显式读取并忽略旧有效期，后续编辑以CAS移除数据库TTL；账号范围和提交锁仍校验，提交前仍向上游重验档期和课件。bookingLimits.maxContiguousLessons=38是当前适配器上限，实际可选仍受返回模板和档期约束，不声称美森所有合约都保证38节成功。
- POST bookings已实现。operationId相同永不重放，包括明确失败；用户手动重试使用新ID。before-send持久prepared→dispatching，保存baseline旧cid，unknown只读教师+北京时间+课件的唯一新记录。明确成功但课表尚未同步返回pendingRecordSync；部分成功返回result.lessons逐项状态。
- GET operations/{id}只读核对；bootstrap.unresolvedOperations恢复本账号未决操作，重新登录同一上游账号后仍可查询旧操作，但不能发送旧绑定请求。
- POST operations/{id}/acknowledge：body={bindingRevision,confirmedInApp:true}。仅超过60秒的未决操作可由用户在App核实后结束跟踪，标为cancelled，绝不取消/重约/退额。
- POST bookings/{key}/cancel已串联两阶段；第二步未知保留needs_repair，只读核对。status=2涉及额外规则，不能自动接受，留待App确认。批量顺延未实现。
- GET bookings/{key}/resources已核验：B course/courseClassResource，body={lessonid:courseid,type:live或back,cid,producttype}；学生use_type=1；filepath是相对路径，不能自己拼URL。B download/pdf，body={fid:id}返回data.file_url，实测为HTTPS file.mison.cn PDF。只代理学生PDF，不转发教师文件。
- 学习actions/classroom、replay、homework目前返回Resource.instructions并给出App路径，不调用未经核实的PC课堂协议，不返回含持久Token的外部链接。
- 取消/预约/预览在真实环境均未执行；只读核验使用原Token。用户明确约束：任何真实约课测试均不能提交距今48小时以内的课程。

PDF地址按App encodeURI行为规范化空格与非ASCII路径，保留已有percent转义，随后仍要求固定HTTPS来源、合法端口和PDF后缀。编码不放宽域名/内网/重定向校验。
