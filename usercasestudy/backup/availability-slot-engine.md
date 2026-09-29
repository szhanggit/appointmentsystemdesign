# Availability Slot Engine 设计（2026-09-29，v2：按 GitHub 基线修正）

本地 spec，供 Claude Code 实现。术语：Chain = 连锁，store = 一家店，merchant 停用。

**基线声明**：以 GitHub `usercasestudy/store-onboarding-v1-design.md`（2026-09-29 版）为基线。
关键基线事实：`appointments` 是**单人单块**模型（头挂 `staff_id`（人级）+ `starts_at/ends_at`）；
`staff_schedules` 挂 assignment；`staff_time_offs` 人级 tstzrange。

配套文档：
- `availability-schema.md` —— 输入表的定义
- `staff-schedule-entry-workflow.md` —— 输入数据怎么填进来
- 下一篇（未写）：`create-appointment` 事务与防 double-booking —— slot engine 只负责"算出能约的时间"，**不负责锁定**

## 0. 一句话定位

给定（门店，服务/选项，日期，[指定员工]），算出当天所有可预订的开始时间。**纯计算，无副作用，不写库，不预占**——看到 slot 不等于拥有 slot。

## 1. 输入与输出

### 输入（`GET /api/store/public/slots` 的 query 参数）

| 参数 | 必填 | 说明 |
|---|---|---|
| `store_id` | 是 | 门店 |
| `service_id` | 是 | 服务 |
| `option_id` | 条件必填 | 服务 `price_type='from'` 时必填，否则 400 `OPTION_REQUIRED` |
| `date` | 是 | `YYYY-MM-DD`，按门店时区解释 |
| `staff_id` | 否 | 指定员工（**人级** `store.staff.id`）；不传 = "任意可用员工"模式 |

### 输出

```json
{
  "store_id": "…",
  "service_id": "…",
  "option_id": "…",
  "date": "2026-10-05",
  "timezone": "America/Toronto",
  "duration_minutes": 60,
  "buffer_before_minutes": 0,
  "buffer_after_minutes": 10,
  "slots": [
    { "start": "2026-10-05T09:00:00", "end": "2026-10-05T10:00:00", "staff_ids": ["uuid-a", "uuid-b"] },
    { "start": "2026-10-05T09:15:00", "end": "2026-10-05T10:15:00", "staff_ids": ["uuid-a"] }
  ]
}
```

- 时间一律门店本地时间 `YYYY-MM-DDTHH:mm:ss`（沿用基线约定）。
- `staff_ids` 是**人级** id（客户选的是人，不是 assignment）；内部计算按 assignment。
- `end = start + duration_minutes`（不含 buffer；buffer 只影响"能不能约"，不显示给客户）。

## 2. 前置检查（任一失败直接返回错误，不进算法）

1. 门店存在且未删、未停用；否则 404。
2. 服务属于该门店、`status='active'`、未软删；否则 404（跨店按 404 口径）。
3. 服务满足"可在线预约"（基线 §：active + 未删 + ≥1 个 assignment 分配了该服务 + `from` 有未删 option）；否则 409 `SERVICE_NOT_BOOKABLE`。
4. `date` 合法且 `today(store_tz) <= date <= today + advance_booking_days`；过去 → 400 `DATE_IN_PAST`，太远 → 400 `DATE_TOO_FAR`。
5. 指定 `staff_id` 时：此人存在且在本店有 assignment（无 assignment → 404）。即使该员工当天完全没空，也返回 200 + 空 slots（"存在但没空" ≠ "不存在"）。

## 3. 时长与 buffer 的确定（v1 规则）

- `D = duration_minutes`：`from` 用所选 option 的，否则用服务的。
- `Bb / Ba`：`services.buffer_before/after_minutes` 非空则用服务的，否则用 `booking_settings` 店级默认。
- 总占用块：`[s - Bb, s + D + Ba]`，s = 候选开始时间。

## 4. 算法

记目标日期为 T（门店时区），`dow(T)` 为星期几。对**每位候选员工**独立计算，最后合并。

候选集合 = 在本店满足"可被预约"（entry workflow §6，**按 assignment**）的 assignments；指定模式则只取该人的本店 assignment。

### 步骤

**Step 1 — 店铺开门区间 O**：`business_hours WHERE store_id AND day_of_week = dow(T) AND open_time IS NOT NULL` → `[open_time, close_time]`。O 为空（关门/未设置）→ 直接返回空 slots。

**Step 2 — 员工上班区间 W**：`staff_schedules WHERE staff_store_assignment_id AND day_of_week = dow(T)` → 所有 `[start_time, end_time]`。

**Step 3 — 基础可用 A0 = O ∩ W**（区间集合求交）。

**Step 4 — 减去请假**：`staff_time_offs WHERE staff_id` 且 `tstzrange(starts_at, ends_at) && [T 00:00, T+1 00:00)`（门店时区转 UTC 后比较）。相交部分从 A0 减去。**人级**：该员工所有店同时不可用——本店算 slot 时直接减，无需关心他在别的店。

**Step 5 — 减去已有预约占用**：`store.appointments WHERE store_id AND staff_id AND status = 'confirmed'` 且时间块与 T 相交。每条占用 `[starts_at - buffer_before_minutes, ends_at + buffer_after_minutes]`（取**预约头上的 buffer 快照**，schema §6），从 A0 减去。
（基线是单人单块模型：占用直接读 appointments 头，不用下钻到 items。`is_test` 的预约占不占 slot？基线 §5 说 quota 相关——**本 engine 照占**：测试预约也是真实占了员工时间；quota 另算。待确认项，见 §8。）

**Step 6 — 减去"已经过去的时间"**：若 T 是今天（门店时区），减去 `[00:00, now() + min_lead_minutes]`。

**Step 7 — 切片**：对 A0 每段 `[a, b]`，可行 s 满足 `[s - Bb, s + D + Ba] ⊆ [a, b]`，
即 `s ∈ [a + Bb, b - Ba - D]`，按下界向上对齐到 `slot_granularity_minutes` 步长取点。放不下整个服务的段直接跳过（不给切一半的 slot）。

**Step 8 — 合并（仅"任意员工"模式）**：按 start 聚合，`staff_ids` 为该 start 可服务的人 id 列表（按员工 sort_order/创建时间排序）。

### 伪代码

```
function getSlots(store, service, option, date, staffId?):
    check §2 前置条件
    D, Bb, Ba = §3
    O = businessHours(store, dow(date))            # 非 NULL 行
    if O empty: return []
    assigns = bookableAssignments(store, service, staffId?)   # 按 assignment
    slotsByStart = {}
    for a in assigns:
        W = staffSchedules(a.id, dow(date))
        A = intersect(O, W)
        A = subtract(A, timeOffsIntersecting(a.staff_id, date))  # Step 4，人级
        A = subtract(A, occupiedBlocks(store.id, a.staff_id, date))  # Step 5，读 appointments 头
        if date == today(store.tz):
            A = subtract(A, [00:00, now()+min_lead_minutes])
        for [s_lo, s_hi] in feasibleStarts(A, Bb, Ba, D, slot_granularity_minutes):
            for s in range(s_lo, s_hi+1, slot_granularity_minutes):
                slotsByStart[s].add(a.staff_id)   # 输出人级 id
    return sorted(slotsByStart)
```

复杂度：单店单日，毫秒级。**v1 实时计算，不缓存**（正确性优先）。

## 5. "任意员工" vs "指定员工"

- **指定员工**：只算该人的本店 assignment，`staff_ids` 单元素。
- **任意员工**：并集 + 每 slot 的 `staff_ids`。客户选"任意"后到底派给谁，engine 不决定——创建事务里按 `staff_ids` 顺序取第一个（v1 简单可预测；create doc 可升级策略）。

## 6. 时区与 DST

- `date`、`dow`、`today`、`now()` 全按 `stores.timezone`；内部比较转 UTC。
- DST 切换日 v1 不特殊处理（note 给 QA：春秋季切换日各 regression 一次）。

## 7. API 定义

`GET /api/store/public/slots?store_id=&service_id=&option_id=&date=&staff_id=`

- 公开接口，无需登录，按 IP + store_id 限流。
- 200 即使空 slots（"没空"是正常业务状态）。
- 错误码：`OPTION_REQUIRED`(400) / `DATE_IN_PAST`(400) / `DATE_TOO_FAR`(400) / `SERVICE_NOT_BOOKABLE`(409) / 跨店不存在资源(404)。
- 作废旧草图 `GET /public/stores/{slug}/availability`（base 统一 `/api/store`，定位用 `store_id`）。

## 8. 未决问题（本篇不决议）

1. **`auto_confirm=false`**：`status` 无 `pending`，未确认预约占不占 slot？下一篇 create doc 先决议，本篇 v1 只减 `confirmed`。
2. **`is_test` 预约**：本篇按"照占"处理（占的是真实员工时间）；若基线 §5 的 quota 语义另有说法，create doc 统一。
3. **多服务连约**：v1 slots API 只查**单个**服务(+option)。一单多服务在创建时按顺序排成一个连续块（头上的 `starts_at/ends_at` 即该块），规则写进下一篇。

## 9. v1 不做的事

- slot 预占/临时锁定（靠创建事务原子性保证，冲突时报 `SLOT_TAKEN` 引导重选）。
- 等候名单；按时段计价；容量型服务（1 对 N 课程）——`max_guests`/`allow_group` 已建议砍（schema §4）。

---

## 修正记录（2026-09-29 v2）

- 候选计算改为**按 assignment**（Q1）；输出 `staff_ids` 保持人级。
- Step 4 请假改为**人级** tstzrange 相交（Q4 配套）。
- Step 5 占用改为读 **`appointments` 头**（单人单块模型），用头上的 buffer 快照展开。
- 列名改用基线新名：`slot_granularity_minutes` / `advance_booking_days`。
