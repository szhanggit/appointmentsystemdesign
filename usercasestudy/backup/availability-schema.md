# Availability Schema 设计（2026-09-29，v2：按 GitHub 基线修正）

本地 spec，供 Claude Code 实现。术语：Chain = 连锁，store = 一家店，merchant 停用。

**基线声明**：本文件以 GitHub `usercasestudy/store-onboarding-v1-design.md`（2026-09-29 版）为基线。
v1 草稿曾依据本地旧文档，漏掉了 9/29 的几处决议，本版已修正（见末尾"修正记录"）。
基线已有的表本文件**不重写**，只记录"补充决议"（新增列/约束/快照）。

配套文档：
- `staff-schedule-entry-workflow.md` —— 谁在什么时候填这些表、验证规则、API
- `availability-slot-engine.md` —— slot engine 如何消费这些表、算法、`GET /slots`

## 设计总览

slot engine 的输入（全部 store schema）：

| 表 | 基线状态 | 本文件补充 |
|---|---|---|
| `store.business_hours` | GitHub 已有：一天一行，`open_time/close_time` NULL=关门 | 补 `UNIQUE(store_id, day_of_week)` + NULL 一致性 CHECK |
| `store.staff_store_assignments` | GitHub 已有：人-店多对多，`UNIQUE(staff_id, store_id)` | 无补充（引用） |
| `store.staff_schedules` | GitHub 已有：**挂 `staff_store_assignment_id`**（非 staff_id） | 补唯一索引；明确多行/天、分段上班语义 |
| `store.staff_time_offs` | GitHub 已有：**人级** `staff_id` + `starts_at/ends_at TIMESTAMPTZ` | 补防重叠 exclusion constraint（btree_gist） |
| `store.booking_settings` | GitHub 已有：3 字段（`slot_granularity_minutes`/`advance_booking_days`/`auto_confirm`） | 新增 `min_lead_minutes`、`buffer_before/after_minutes` |
| `store.services` / `service_options` | service-catalog-design.md 已定 | 新增可空的服务级 buffer 覆盖列 |
| `store.appointments` | GitHub 已有：**单人单块**（头挂 `staff_id` + `starts_at/ends_at`） | 新增 buffer 快照列 |
| `store.appointment_items` | GitHub 已有：`service_id` + `price_cents` 快照 | 新增 `service_name`/`option_id`/`option_name`/`duration_minutes` 快照（service-catalog 已决议） |

---

## 1. store.business_hours（基线：一天一行，NULL=关门）

```sql
-- 基线（GitHub 2026-09-29）：id / store_id FK / day_of_week 0..6 / open_time TIME NULL / close_time TIME NULL
-- 本文件补充约束：
ALTER TABLE store.business_hours
    ADD CONSTRAINT uq_business_hours_day UNIQUE (store_id, day_of_week),
    ADD CONSTRAINT chk_business_hours_null CHECK (
        (open_time IS NULL AND close_time IS NULL) OR
        (open_time IS NOT NULL AND close_time IS NOT NULL AND close_time > open_time)
    );
```

- 一天**一行**；`open_time/close_time` 全 NULL = 当天关门；半 NULL 非法（CHECK 拦）。
- 缺行 = 该天未设置，engine 视为关门；开业门槛检查要求 7 行齐（见 entry workflow §2.3）。
- **分段营业**（如中午休息）：基线不支持。v1 不做——spa 业态单段营业覆盖 95%，且 engine 本来就是按区间集合算的，将来要加只是"允许多行"的 UI+约束改动，不动 engine。先不折腾。

## 2. store.staff_schedules（基线：挂 assignment，多行/天）

```sql
-- 基线（GitHub 2026-09-29）：
-- id / staff_store_assignment_id FK / day_of_week 0..6 / start_time TIME NOT NULL / end_time TIME NOT NULL
-- 本文件补充：
ALTER TABLE store.staff_schedules
    ADD CONSTRAINT chk_schedule_range CHECK (end_time > start_time),
    ADD CONSTRAINT uq_staff_schedules_row UNIQUE (staff_store_assignment_id, day_of_week, start_time);
CREATE INDEX idx_staff_schedules_assignment_id ON store.staff_schedules(staff_store_assignment_id);
```

- **挂 `staff_store_assignment_id`，不是 `staff_id`** —— 同一个人在不同店排班可以不一样（9/29 决议，见末尾修正记录 Q1）。
- 一天可多行 = 分段上班（如 `09:00-12:00` + `14:00-18:00`）；当天无行 = 休息。
- 同天行之间不许重叠，应用层校验 → `400 {error: SCHEDULE_OVERLAP}`（DB 层也可用 exclusion，但 TIME 的 gist 需要 btree_gist 且语义与 time_offs 不同，v1 应用层拦即可）。
- 周模板：engine 按目标日期的星期几查；某天的例外走 `staff_time_offs`，不改模板。

### 默认继承规则（保持 v1 决议，修正挂载点）

**assignment 创建时**（人被加入某店的那一刻），系统把当前 `business_hours` 物化复制为该 assignment 的初始 `staff_schedules`。
复制不是引用：之后门店改营业时间不影响已有 assignment 的排班；想跟回用"重置为门店时间"（entry workflow §3.2，显式操作）。

## 3. store.staff_time_offs（基线：人级 + tstzrange，补防重叠）

```sql
-- 基线（GitHub 2026-09-29）：id / staff_id FK → store.staff / starts_at TIMESTAMPTZ / ends_at TIMESTAMPTZ / reason VARCHAR(200)
-- 本文件补充：
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE store.staff_time_offs
    ADD CONSTRAINT chk_time_off_range CHECK (ends_at > starts_at),
    ADD CONSTRAINT no_overlapping_time_offs
        EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&);
CREATE INDEX idx_staff_time_offs_staff_id ON store.staff_time_offs(staff_id);
```

- **人级**（挂 `staff_id`，不挂 assignment）：生病/有事 = 所有店都不去。语义简单，无歧义。
- `tstzrange` 精确到分钟，天然支持跨天假（如周五 22:00 到周六 02:00 的行程——请假可以跨天，排班模板不行）。
- **防重叠用数据库 exclusion constraint**（Q4 的答案）：同一人任意两条时间范围不许相交。`400/409 {error: TIME_OFF_OVERLAP}`（实现时把 PG 的 exclusion_violation 映射成该错误码）。
  - 全天假 + 当天时间段假并存 → 被拦（全天已覆盖，时间段是冗余输入，拦掉是对的）。
  - 09:00-10:00 与 09:30-11:00 并存 → 被拦。
- v1 不做周期性请假（rrule），多天用多条。

## 4. store.booking_settings（基线 3 字段 + 本文件新增 3 字段）

```sql
-- 基线（GitHub 2026-09-29）：
-- store_id PK / slot_granularity_minutes INT DEFAULT 15 / advance_booking_days INT DEFAULT 90 / auto_confirm BOOLEAN DEFAULT TRUE
-- 本文件新增：
ALTER TABLE store.booking_settings
    ADD COLUMN min_lead_minutes      INT NOT NULL DEFAULT 60 CHECK (min_lead_minutes >= 0),
    ADD COLUMN buffer_before_minutes INT NOT NULL DEFAULT 0  CHECK (buffer_before_minutes >= 0),
    ADD COLUMN buffer_after_minutes  INT NOT NULL DEFAULT 0  CHECK (buffer_after_minutes >= 0);
```

- **列名采用基线新名**：`slot_granularity_minutes`（切片步长）、`advance_booking_days`（最远可约天数）。v1 草稿里的 `slot_minutes` / `max_days_ahead` 作废。
- `min_lead_minutes`（默认 60）：当天可约开始时间必须晚于 `now() + min_lead`（门店时区）。
- `buffer_before/after_minutes`（默认 0）：店级默认前后缓冲（准备/收尾时间），服务可覆盖（§5）。

### 关于 9/29 精简掉的 5 个字段（Q2，待 Steven 确认）

旧版同一份文档曾有 8 个字段，9/29 重写精简到 3 个。去掉的 5 个去向建议：

| 字段 | 建议 | 理由 |
|---|---|---|
| `payment_required` | **要回来** | 定金/预付是 v1 scope（GOAL 明确有 deposits/cards-on-file），没这个开关定金功能无处挂 |
| `cancel_threshold_hours` | **要回来** | 取消政策，下一篇 cancel/reschedule 文档必须消费它 |
| `max_guests` / `allow_group` | 可砍 | 多人/团购服务，engine v1 明确不做（slot engine §9） |
| `max_appointment_minutes` | 可有可无 | 单次预约时长上限的安全阀；真要可加 CHECK，不急 |

**在 Steven 确认前，本文件不加这 5 列**；确认要回来的两个，SQL 一行就行，不影响现有设计。

## 5. store.services（补充：服务级 buffer 覆盖列）

```sql
ALTER TABLE store.services
    ADD COLUMN buffer_before_minutes INT NULL CHECK (buffer_before_minutes >= 0),
    ADD COLUMN buffer_after_minutes  INT NULL CHECK (buffer_after_minutes >= 0);
```

- `NULL` = 继承店级 `booking_settings`；非空 = 该服务覆盖。
- 服务级不分 option：`from` 服务的各选项共用同一套缓冲，v1 够用。

## 6. store.appointments（基线：单人单块，补 buffer 快照列）

基线（GitHub 2026-09-29）：**一个预约 = 一个员工 + 一个时间块**，`staff_id`（人级，应用层保证此人在本店有 assignment）+ `starts_at/ends_at TIMESTAMPTZ` 挂在头上；`status` 无 `pending`（`auto_confirm=false` 的行为下一篇决议）。

```sql
-- 本文件新增：下单时的 buffer 快照（engine Step 5 展开占用区间用，不用再反查服务）
ALTER TABLE store.appointments
    ADD COLUMN buffer_before_minutes INT NOT NULL DEFAULT 0,
    ADD COLUMN buffer_after_minutes  INT NOT NULL DEFAULT 0;
```

- 快照规则（create-appointment 文档细化）：`buffer_before` 取首项服务的 Bb，`buffer_after` 取末项服务的 Ba（多服务按顺序连排时的语义）。
- 快照了就不再变：以后服务改 buffer，不追溯已有预约（与价格/时长快照同一哲学）。

## 7. store.appointment_items（补快照列，与 service-catalog 决议对齐）

基线：`service_id` + `price_cents`（价格快照，已有）。

```sql
ALTER TABLE store.appointment_items
    ADD COLUMN service_name     TEXT NOT NULL,
    ADD COLUMN option_id        UUID NULL,   -- fixed/free 服务为 NULL
    ADD COLUMN option_name      TEXT NULL,
    ADD COLUMN duration_minutes INT NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720);
```

- 这是 `service-catalog-design.md`（Steven 9/29 已批）的"预约快照"决议：改名、改价、改时长、软删都不追溯历史。GitHub onboarding 文档还没合入，以本文件为准。
- `duration_minutes` = 纯服务时长（不含 buffer）；实际占用块 = `appointments.starts_at/ends_at`（已含缓冲展开，engine 定义）。

## 8. 时区约定（沿用基线）

- `store.stores.timezone` 唯一基准；API 用门店本地时间 `YYYY-MM-DDTHH:mm:ss`；服务端存 UTC。
- `staff_time_offs.starts_at/ends_at` 是 timestamptz：engine 按"与目标日期（门店时区）相交"判断。

---

## 修正记录（2026-09-29 v2）

v1 草稿依据的是本地旧文档，漏了 GitHub 基线 9/29 的决议，本版修正：

1. **Q1**：`staff_schedules` 从 v1 的 `staff_id` 改回挂 **`staff_store_assignment_id`**。v1 是起草失误，不是故意撤销——GitHub 基线注释写得清楚："Working hours differ per store for the same person, so this is keyed off the assignment too"。`staff_services` 同理（基线已是 assignment 级，本文件不重复）。
2. **Q2**：`booking_settings` 列名改用基线新名（`slot_granularity_minutes` / `advance_booking_days`）；v1 列的 5 个"旧字段"实为 9/29 精简掉的，§4 列出要回/可砍建议，待 Steven 确认。
3. **Q4**：`staff_time_offs` 防重叠**补上了**，用 exclusion constraint（§3），不是故意放松。
4. `staff_time_offs` 采用基线的人级 + tstzrange 设计（取代 v1 的 date+time 列设计）：人请假=所有店都休，跨天假天然支持。
5. `business_hours` 采用基线的"一天一行 + NULL=关门"（取代 v1 的"无行=关门/多行"）：分段营业 v1 不做（§1）。
6. 占用计算改为读 `appointments` 头（单人单块模型），不再是 v1 的按 item 读。
