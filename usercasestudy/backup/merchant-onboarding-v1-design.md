# 商户入驻流程设计（V1 · 手动入驻版）

> 产品愿景：预约软件，不止是一本日历。
> V1 决策：不做自助注册。商户发邮件 → 我们在 Back Office 手动录入。
> V1 范围：只做预约前。对标 Fresha 预约前功能切片 + byChronos POS 实测结构。
> 本文档面向 Claude Code：按此实现 V1 商户入驻链路。

---

## 1. 整体流程

```
商户看到我们 → 发邮件（含信息模板 §3）
↓
管理员在 Back Office 新建商户（§4 线框图）
↓
录入基本信息 → 添加服务 → 添加员工 → 分配"员工↔服务" → 设置营业时间/预约规则
↓
生成在线预约链接 → 把链接交付给商户 → 商户可对外接预约
```

流程状态机（`merchants.status`）：`pending`（新建）→ `active`（交付可用）→ `suspended`（停用）

---

## 2. 名词说明

| 名词 | 说明 |
|---|---|
| Merchant（商户） | 一家店或一个独立从业者。独立从业者 = 只有 1 名员工（本人）的商户 |
| Staff（员工） | 商户内的人，角色：`owner` 店主 / `manager` 店长 / `staff` 普通员工 |
| Service（服务） | 可预约项目，如"头部拨筋+头疗+肩颈按摩" |
| Staff↔Service | 多对多：某员工能做哪些服务（byChronos 实测：服务在员工档案的 SERVICES 页逐个分配） |
| Slot | 预约时间粒度，默认 15 分钟 |

---

## 3. Intake Email 模板（商户发给我们的邮件）

> 这封邮件的字段 = V1 商户数据模型的草稿。字段稳定后可直接转成网页表单（自助注册 V2）。

```
主题：{商户名称}

1. 商户名称（对外展示）：
2. 联系人 / 电话 / 邮箱：
3. 门店地址：
4. 时区：（默认 America/Toronto）
5. 商户类型：[] 独立从业者（1人） [] 团队店（多人）
6. 服务项目（可附 Excel，请按此格式）：
名称 | 时长(分钟) | 价格 | 价格类型(固定/可变) | 分类
例：头部拨筋+头疗+肩颈按摩 | 90 | 128 | 固定 | Signature Head Spa
7. 员工（姓名 | 电话 | 可做上表中的哪些服务）：
例：ANNA | 416-xxx-xxxx | 头部拨筋+头疗+肩颈按摩, 面部清洁+头疗
8. 营业时间（周一至周日，每天 开始-结束，不营业写"休"）：
9. 预约规则偏好：时间粒度（默认15分钟）/ 可提前预约天数（默认90）/ 是否自动确认（默认是）
```

---

## 4. Back Office 线框图（Wireframe）

> 给内部管理员用的，糙一点没关系，功能跑通优先。
> 新建商户是分步向导：①基本信息 → ②服务 → ③员工 → ④营业时间与规则 → ⑤完成交付。

### 4.1 商户列表页

```
+------------------------------------------------------------------+
| Back Office > 商户管理 [+ 新建商户] |
+------------------------------------------------------------------+
| 搜索: [____________] 状态: [全部 ▾] |
+------------------------------------------------------------------+
| 商户名称 | 类型 | 员工数 | 服务数 | 状态 | 操作 |
|-----------------|------|--------|--------|------|------------------|
| SELAH HEAD SPA | 团队 | 16 | 32 | 启用 | 查看 编辑 停用 |
|... | | | | | |
+------------------------------------------------------------------+
| < 1 2 3 > |
+------------------------------------------------------------------+
```

### 4.2 新建商户 ① 基本信息

```
+------------------------------------------------------------------+
| 新建商户 ①基本信息 → ②服务 → ③员工 → ④营业时间与规则 → ⑤完成 |
+------------------------------------------------------------------+
| 商户名称（对外展示）*: [________________________] |
| 联系人*: [____________] 电话*: [____________] |
| 邮箱*: [________________________] |
| 地址: [________________________________________] |
| 城市: [____________] 省: [____] 邮编: [________] |
| 时区: [America/Toronto ▾] |
| 类型: () 独立从业者（1人） () 团队店（多人） |
+------------------------------------------------------------------+
| [取消] [下一步 →] |
+------------------------------------------------------------------+
```

### 4.3 新建商户 ② 服务管理

```
+------------------------------------------------------------------+
| 新建商户 ①基本信息 → ②服务 → ③员工 →... [+ 添加服务] |
+------------------------------------------------------------------+
| 分类: [All][Signature Head Spa][Facial Care][Body Care]... |
+------------------------------------------------------------------+
| 服务名称 | 时长 | 价格 | 类型 | 操作 |
|---------------------------|-------|-----------|------|-----------|
| 头部拨筋+头疗+肩颈按摩 | 90分钟| $128.00 | 固定 | 编辑 删除 |
| Signature Soothing Head.. | 60分钟| VARIABLE | 可变 | 编辑 删除 |
+------------------------------------------------------------------+
| 添加服务（弹窗）: |
| 名称(中/英): [____________] 分类: [________ ▾] |
| 时长(分钟)*: [____] 价格类型: ()固定 [____] ()可变 |
| 描述: [____________] [保存] [取消] |
+------------------------------------------------------------------+
| [← 上一步] [下一步 →] |
+------------------------------------------------------------------+
```

### 4.4 新建商户 ③ 员工管理 + 服务分配

```
+------------------------------------------------------------------+
| 新建商户... → ③员工 → ④... [+ 添加员工] |
+------------------------------------------------------------------+
| 员工 | 角色 | 电话 | 可做服务数 | 状态 | 操作 |
|--------|----------|--------------|------------|------|-------------|
| ANNA | 普通员工 | 416-xxx-xxxx| 27 | 在职 | 服务分配... |
| CONNIE | 店长 | 416-xxx-xxxx| 18 | 在职 | 服务分配... |
+------------------------------------------------------------------+
| 服务分配（弹窗，员工: ANNA）: |
| [x] 头部拨筋+头疗+肩颈按摩 [x] 面部清洁+头疗 |
| [] 全身精油按摩 [] 足底反射按摩 |
| [保存] [取消] |
+------------------------------------------------------------------+
| 排班: 在员工行点"排班" → 周一至周日 每天 [开始__][结束__][休☐] |
| [← 上一步] [下一步 →] |
+------------------------------------------------------------------+
```

### 4.5 新建商户 ④ 营业时间与预约规则

```
+------------------------------------------------------------------+
| 新建商户... → ④营业时间与规则 → ⑤完成 |
+------------------------------------------------------------------+
| 营业时间（门店）: |
| 周一 [x营业] [10:00] - [23:00] 周二 [x营业] [10:00] - [23:00] |
|...（周三~周日同理，特殊闭店日另加） |
| 预约规则: |
| 时间粒度: [15 ▾] 分钟 最长单次预约: [300] 分钟 |
| 可提前预约: [90] 天 最多同行人数: [12] |
| [x] 自动确认预约 [x] 允许拼单/多人预约 [] 预约时必须付款 |
| 取消/改期提前: [0] 小时（0=随时可取消） |
+------------------------------------------------------------------+
| [← 上一步] [下一步 →] |
+------------------------------------------------------------------+
```

### 4.6 新建商户 ⑤ 完成交付

```
+------------------------------------------------------------------+
| 新建商户... → ⑤完成 |
+------------------------------------------------------------------+
| ✓ 商户已创建 |
| 在线预约链接: https://book.ourdomain.com/selah-head-spa [复制] |
| 商户: SELAH HEAD SPA ｜ 服务 32 项 ｜ 员工 16 人 |
+------------------------------------------------------------------+
| [返回商户列表] |
+------------------------------------------------------------------+
```

---

## 5. 数据库设计

> 命名：snake_case；金额用 `*_cents` 整数（分）；时间为带时区时间戳。
> V1 单门店：地址/时区直接挂在 merchants 上，多门店以后再拆 locations 表。

### 5.1 merchants（商户）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| slug | varchar(64) unique not null | 预约链接用，如 `selah-head-spa` |
| name | varchar(128) not null | 对外展示名 |
| business_type | enum: `independent`,`team` | 个人 / 团队店 |
| contact_name | varchar(64) | 联系人 |
| contact_phone | varchar(32) | |
| contact_email | varchar(128) | |
| address / city / province / postal_code / country | varchar | 地址 |
| timezone | varchar(64) not null default 'America/Toronto' | |
| status | enum: `pending`,`active`,`suspended` not null default 'pending' | |
| created_at / updated_at | timestamptz | |

### 5.2 services（服务）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| merchant_id | uuid FK → merchants | +索引 |
| category | varchar(64) | 分类，如 Signature Head Spa |
| name | varchar(128) not null | 双语名存一个字段即可 |
| duration_minutes | int not null | 时长 |
| price_type | enum: `fixed`,`variable` not null default 'fixed' | 固定价/可变价（byChronos 实测有 VARIABLE） |
| price_cents | int | fixed 时必填 |
| description | text | |
| is_active | boolean default true | |
| sort_order | int default 0 | 展示排序 |

### 5.3 staff（员工）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| merchant_id | uuid FK → merchants | +索引 |
| name | varchar(64) not null | |
| phone / email | varchar | |
| role | enum: `owner`,`manager`,`staff` not null default 'staff' | |
| status | enum: `active`,`inactive` default 'active' | |
| created_at / updated_at | timestamptz | |

### 5.4 staff_services（员工↔服务，多对多）

| 字段 | 类型 | 说明 |
|---|---|---|
| staff_id | uuid FK → staff | 联合 PK (staff_id, service_id) |
| service_id | uuid FK → services | |

### 5.5 staff_schedules（员工排班）+ staff_time_offs（请假/特殊时段）

staff_schedules：id / staff_id FK / day_of_week (0=周日..6=周六） / start_time / end_time / is_working
staff_time_offs：id / staff_id FK / date / reason（V1 简单按整天休假处理）

### 5.6 business_hours（门店营业时间）

merchant_id FK / day_of_week / open_time / close_time / is_open

### 5.7 booking_settings（预约规则，每商户一行）

merchant_id FK unique / slot_minutes default 15 / max_appointment_minutes default 300 /
max_days_ahead default 90 / max_guests default 12 /
auto_confirm default true / allow_group default true / payment_required default false /
cancel_threshold_hours default 0（0=随时可取消）

### 5.8 customers（客户档案，V1 基础字段）

id / merchant_id FK+索引 / name / phone not null（必填） / email / birthday / note /
created_at。余额/积分/等级 → V2（预约后范畴）。

### 5.9 appointments（预约）+ appointment_items（预约明细）

appointments：id / merchant_id FK / customer_id FK / status enum(`confirmed`,`cancelled`,`completed`,`no_show`) /
channel enum(`online`,`manual`) not null（记录来源）/ total_price_cents / note / created_by（manual 时记录操作人）/ created_at

appointment_items（一单可含多项服务，byChronos 实测一单 2 项服务）：
id / appointment_id FK / service_id FK / staff_id FK / start_at / end_at / price_cents

### 5.10 关系简图

```
merchants 1──* services
merchants 1──* staff
staff *──* services (staff_services)
staff 1──* staff_schedules / staff_time_offs
merchants 1──1 booking_settings
merchants 1──* business_hours
merchants 1──* customers
customers 1──* appointments 1──* appointment_items
appointment_items *──1 services / *──1 staff
```

---

## 6. Web API 设计

> Base URL：`/api/v1`。Back Office 接口统一 `/api/v1/admin/*`（需管理员 JWT）。
> 公开预约页接口 `/api/v1/public/*`（无需登录，加限流）。

### 6.1 Back Office 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /admin/merchants | 新建商户（§4.2） |
| GET | /admin/merchants?page=&q=&status= | 商户列表（§4.1） |
| GET/PATCH | /admin/merchants/{id} | 详情 / 更新 |
| POST | /admin/merchants/{id}/suspend · /activate | 停用 / 启用 |
| GET/POST | /admin/merchants/{id}/services | 服务列表 / 新建（§4.3） |
| PATCH/DELETE | /admin/services/{serviceId} | 更新 / 删除 |
| GET/POST | /admin/merchants/{id}/staff | 员工列表 / 新建（§4.4） |
| PATCH | /admin/staff/{staffId} | 更新员工 |
| PUT | /admin/staff/{staffId}/services | 全量设置员工可做服务（body: {serviceIds:[]}） |
| PUT | /admin/staff/{staffId}/schedule | 设置周排班 |
| POST/DELETE | /admin/staff/{staffId}/time-offs | 请假 / 销假 |
| GET/PUT | /admin/merchants/{id}/hours | 营业时间 |
| GET/PUT | /admin/merchants/{id}/booking-settings | 预约规则（§4.5） |
| GET | /admin/merchants/{id}/booking-link | 取预约链接（§4.6） |
| GET/POST | /admin/merchants/{id}/customers | 客户列表 / 手动建档 |

### 6.2 公开预约接口（C 端预约页用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /public/merchants/{slug} | 商户公开信息+服务列表（预约页渲染） |
| GET | /public/merchants/{slug}/availability?service_id=&staff_id=&date= | 查某天可用时间段 |
| POST | /public/bookings | 创建预约 |

### 6.3 关键接口示例

**POST /admin/merchants（新建商户）**
```json
// Request
{
"name": "SELAH HEAD SPA",
"slug": "selah-head-spa",
"businessType": "team",
"contactName": "xxx", "contactPhone": "416-xxx-xxxx",
"contactEmail": "xxx@gmail.com",
"address": "280 West Beaver Creek Rd...", "city": "Richmond Hill",
"province": "ON", "postalCode": "L4B 3B1", "country": "Canada",
"timezone": "America/Toronto"
}
// Response 201
{ "id": "uuid", "slug": "selah-head-spa",
"bookingUrl": "https://book.ourdomain.com/selah-head-spa",
"status": "pending"}
```

**GET /public/merchants/{slug}/availability?service_id=&date=2026-10-01**
```json
// Response 200（按 booking_settings.slot_minutes 切分，排除已有预约/员工休假/非营业时间）
{ "date": "2026-10-01",
"slots": [
{ "start": "10:00", "end": "11:30",
"staff": [{ "id": "uuid", "name": "ANNA"}]}
]}
```

**POST /public/bookings（创建预约）**
```json
// Request
{ "merchantSlug": "selah-head-spa",
"items": [{ "serviceId": "uuid", "staffId": "uuid", "start": "2026-10-01T10:00:00"}],
"customer": { "name": "张三", "phone": "416-xxx-xxxx", "email": "x@y.z"},
"note": "第一次来"}
// Response 201
{ "id": "uuid", "status": "confirmed", "channel": "online",
"totalCents": 12800}
```
> 预约创建规则：按 service.duration_minutes 推 end；冲突检查（同一员工时间重叠则 409）；auto_confirm=true 直接 confirmed。

### 6.4 通用约定

- 分页：`?page=1&pageSize=20` → `{ items:[], total, page, pageSize}`
- 错误：`{ "code": "SLOT_TAKEN", "message": "..."}`，HTTP 状态码语义化（400/404/409/422）
- 时间：API 全部用商户时区的本地时间 `YYYY-MM-DDTHH:mm:ss`，服务端按 merchant.timezone 存 UTC
- 认证：admin 接口 JWT（V1 单管理员账号即可）；public 接口 IP 限流

---

## 7. V1 不做（明确边界）

- 自助注册 / 邮箱手机验证 / 防刷（→ V2 把 §3 邮件模板转成网页表单）
- KYC / 在线收款 / 定金（booking_settings.payment_required 预留字段，V1 默认 false）
- 短信通知（V1 只做邮件确认通知）
- POS、库存、营销、会员积分、Marketplace、复杂报表、AI 层
- 多门店（locations 表以后再拆）

---

## 8. 实现顺序建议（给 Claude Code）

1. DB 建表（§5）→ 2. Admin 商户 CRUD + 服务/员工/分配/排班 API（§6.1）
2. Back Office 页面按 §4 线框图实现（功能优先，不打磨样式）
3. booking_settings + availability 算法 → 4. Public 预约页 + booking API（§6.2）
4. 手动录入朋友 spa 的真实数据，跑通"发链接 → 预约成功"全链路
