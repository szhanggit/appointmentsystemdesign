# Staff 工作时间填入流程设计（2026-09-29，v2：按 GitHub 基线修正）

本地 spec，供 Claude Code 实现。术语：Chain = 连锁，store = 一家店，merchant 停用。

**基线声明**：以 GitHub `usercasestudy/store-onboarding-v1-design.md`（2026-09-29 版）为基线。
关键基线事实：`store.staff` 是人级（不挂店）；人-店关系是 `store.staff_store_assignments`；
`staff_schedules` / `staff_services` 挂 assignment（店级）；`staff_time_offs` 挂 `staff_id`（人级）。

配套文档：
- `availability-schema.md` —— 表定义
- `availability-slot-engine.md` —— 填进去的数据怎么被消费

## 1. 谁填、填什么

| 数据 | 表 | 挂载点 | 谁填 | 谁能改 |
|---|---|---|---|---|
| 门店营业时间 | `business_hours` | 店 | store_admin（开店流程的一步） | store_admin、chain owner |
| 员工周排班模板 | `staff_schedules` | assignment（人@店） | 员工自己（首选）或 store_admin 代填 | 员工本人只能改自己在该店的；store_admin、chain owner 可改全店 |
| 请假 / 时间段例外 | `staff_time_offs` | 人（`staff_id`） | 员工自己（首选）或 store_admin 代填 | 员工本人只能给自己请；store_admin、chain owner 可代填 |

权限判定统一按 **storeId ∈ caller.AuthorizedStoreIds**（`service-catalog-design.md` 已定）：
- 排班 API 是店级路径（§4）：staff 调自己不在的店的路径 → 404（此人在本店无 assignment，按跨店资源口径）。
- staff 不能碰 `business_hours`（403 `{error: FORBIDDEN}`）。
- 请假 API 是人级路径：staff 只能给自己请（`staff_id == 自己`），给别人请 → 404。

## 2. 什么时候填（onboarding 顺序）

### 2.1 门店级：开店流程的一步

建店 → 填营业时间（7 天一行，NULL=关门）→ 建服务 → 邀员工。顺序理由：assignment 创建时的"默认继承"需要先有营业时间。

### 2.2 员工级：加入某店后的 checklist（按 assignment）

人被加入某店（assignment 创建）后：
1. **确认在该店的周排班** —— 系统已把门店营业时间复制过来，员工只改和自己实际不一样的天。全部正确点"确认"即可。
2. **分配在该店可做的服务**（`staff_services`，挂 assignment，基线已有）。
3. 可选：预填请假（人级）。

同一个人进第二家店 → 新 assignment → 重新走一遍（排班、技能都是店级的，互不干扰）。

### 2.3 门店可接受预约的门槛（派生条件，不存库）

门店对外可预约 ⟺ 同时满足：
- `business_hours` 7 天行齐（营业时间设过）；
- ≥1 个 assignment 满足"可被预约"（§6）；
- ≥1 个服务满足"可在线预约"（service-catalog 已定）。

## 3. 填入交互细节

### 3.1 营业时间编辑器

- 一周七天纵列，每天一行：`开门–关门`（HH:mm）或标记"关门"（= 全 NULL）。
- 提交 = **全量替换 7 行**（PUT，幂等）。

### 3.2 周排班编辑器（员工在某店）

- 一周七天，每天可添加多个时间段行（分段上班）；空天 = 休息，UI 显示"休"。
- 提交 = **全量替换**该 assignment 的周模板（PUT，幂等）。
- 同天时间段重叠 → 前端标红 + 后端 `400 {error: SCHEDULE_OVERLAP}`。

### 3.3 默认继承与"重置为门店时间"

- **assignment 创建时**自动把当前 `business_hours` 物化复制为初始排班（非 NULL 天）。
- 排班页"重置为门店时间" = 用当前 business_hours 全量覆盖（走同样的 PUT + 冲突检查 §5）。
- 门店改营业时间**不自动动任何 assignment**，但提示 store_admin："有 N 个员工排班与新营业时间不一致"，手动逐个处理。

### 3.4 请假（人级）

- 录入：开始/结束两个 datetime（本地时间，服务端转 UTC 存）。快捷方式："选一天" = 当天 00:00–23:59:59；"选几天" = 多条。
- **人级语义**：请了 = 所有店都休。UI 上明确写"请假期间你在所有门店都不可预约"，避免"我只想请 A 店的假"的误解（真有这种需求，v2 再做店级例外）。
- reason 可空；快捷选项（年假/病假/私事/外出）+ 自定义。
- 销假 = DELETE 该行。v1 不做审批流。
- 重叠输入 → 数据库 exclusion constraint 直接拦 → `409 {error: TIME_OFF_OVERLAP}`。

### 3.5 复制排班

`POST /stores/{storeId}/staff/{staffId}/schedule/copy`，body `{from_staff_id}`：把**同店**另一人的周模板全量复制到目标 assignment（覆盖）。跨店复制 → 400（排班是店级的，跨店复制语义不清，v1 不许）。

## 4. API（StoreSession，base `/api/store`）

### 店级（排班、营业时间）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/stores/{storeId}/business-hours` | 取 7 天（含 NULL=关门的天） |
| PUT | `/stores/{storeId}/business-hours` | 全量替换 7 天；支持 `?dry_run=true` |
| GET | `/stores/{storeId}/staff/{staffId}/schedule` | 取该 assignment 的周模板；此人不在本店 → 404 |
| PUT | `/stores/{storeId}/staff/{staffId}/schedule` | 全量替换该 assignment 周模板；支持 `?dry_run=true` |
| POST | `/stores/{storeId}/staff/{staffId}/schedule/copy` | body `{from_staff_id}`（同店） |
| POST | `/stores/{storeId}/staff/{staffId}/schedule/reset-to-store-hours` | 重置为当前门店营业时间 |

### 人级（请假）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/staff/{staffId}/time-offs?from=&to=` | 请假列表（UTC 区间过滤） |
| POST | `/staff/{staffId}/time-offs` | body `{starts_at, ends_at, reason?}`（门店本地时间 ISO，服务端转 UTC） |
| DELETE | `/staff/{staffId}/time-offs/{timeOffId}` | 销假 |

所有店级 PUT/POST 在检测到未来预约冲突时（§5）返回 `409 {error: SCHEDULE_CONFLICT, conflicts: [...]}`，除非带 `?confirm=true`。`?dry_run=true` 只算冲突不写库。

## 5. 验证规则（核心）

### 5.1 时间合法性

- 排班：`start < end`，同天多行不许重叠（`SCHEDULE_OVERLAP`）；v1 不支持跨天。
- 营业时间：NULL 必须成对（CHECK），非空天 `close > open`。
- 请假：`ends_at > starts_at`（CHECK）；`starts_at` 不能是过去（`400 {error: DATE_IN_PAST}`）；重叠 → `409 {error: TIME_OFF_OVERLAP}`（DB exclusion）。

### 5.2 与未来已有预约的冲突

**定义**：改动（排班/营业时间/请假）导致某个 `status='confirmed'` 且 `starts_at` 在未来的预约，其占用块 `[starts_at - buffer_before, ends_at + buffer_after]`（取预约头上的 buffer 快照）不再完全落在"改动后的可用时间"内，即为冲突。注意预约的 `staff_id` 是人级：请假冲突检查要覆盖该人**所有店**的未来预约。

**处理**：`409 {error: SCHEDULE_CONFLICT, conflicts: [...]}` → UI 展示清单 → 操作人 `?confirm=true` 强制提交（系统**不自动改/取消**任何预约，店长手动联系客户）或取消。延长操作永远无冲突，直接写库。

## 6. "可被预约"派生条件（按 assignment，不存库）

某 assignment 可被 slot engine 考虑 ⟺ 同时满足：
1. `store.staff` 行 active 且未删（人级）；
2. 该 assignment 的 `staff_schedules` 有 ≥1 行（至少有一天上班）；
3. 该 assignment 的 `staff_services` 有 ≥1 条（在该店至少会做一个服务）。

任一不满足 → 不进 `GET /slots` 候选；管理后台显示灰色"不可预约"及原因（"未设排班" / "未分配服务"），点跳设置页。用引导，不用报错打断。

## 7. 错误码汇总

| 错误码 | HTTP | 含义 |
|---|---|---|
| `SCHEDULE_OVERLAP` | 400 | 排班同天时间段重叠 |
| `HOURS_INVALID` | 400 | 营业时间半 NULL / close<=open |
| `TIME_OFF_OVERLAP` | 409 | 请假时间范围重叠（DB exclusion） |
| `SCHEDULE_CONFLICT` | 409 | 改动影响未来已有预约（需 confirm=true 重试） |
| `DATE_IN_PAST` | 400 | 请假开始时间是过去 |
| `FORBIDDEN` | 403 | staff 碰 business_hours / 给别人请假 |
| 跨店/无 assignment | 404 | 按既有口径，不暴露存在性 |

## 8. v1 不做的事

- 请假审批流；周期性请假；跨天排班；店级请假例外（请假=所有店）。
- 排班变更自动通知客户（店长手动；自动通知是 reminder pipeline 的事）。
- 工时统计/考勤（排班是"可约时间"，不是打卡记录）。

---

## 修正记录（2026-09-29 v2)

- Q1：排班 API 改为**店级路径**（`/stores/{storeId}/staff/{staffId}/schedule`），内部解析 assignment；"默认继承"挂载点改为 assignment 创建时。
- 请假 API 改为**人级路径**，body 改为 `{starts_at, ends_at}` timestamptz 语义；重叠校验改为 DB exclusion（Q4）。
- 营业时间采用基线"一天一行 + NULL=关门"，PUT 全量替换 7 行。
