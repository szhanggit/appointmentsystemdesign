# Groway 定价框架 v1（2026-09-28）

> 状态：草案。Pilot 跑起来后按真实数据调。真正的验证是第二家非朋友的店愿不愿意掏钱。

## 定价原则

1. **预订是钩子，AI 是利润中心**。对连锁的存量生意（预约）温柔，对我们创造的增量（AI 填空位、召回）收费。连锁老板心理："你帮我多赚钱，我分你一点"——比"你本来就有，我抽一刀"好卖。
2. **免费档要真能用**。免费档的目标是供给冷启动：让单人连锁（一家店、一个人）免费用、形成习惯、有口碑；有团队的店自然超额转化。
3. **AI 按量/按效果，不包"无限"**。AI 有实打实的 token、短信、语音成本，定价必须覆盖成本并留 margin。
4. **对标本地竞品**。GTA 的连锁会拿 COSReady（CA$39/79/119/199/月，免费档 150 预约/月）和 Fresha（软件免费、新客抽成 20%）来比价。

## 版本阶梯

| | 免费版 Free | 付费版 Paid |
|---|---|---|
| 价格 | CA$0 | **CA$49/门店/月**（试运行建议价 — 2026-10-03 修订：per-store, not per-chain; see "已确认事项" #4） |
| 门店 | 不限（适合单人单店） | 没有限制 |
| 员工 | **没有限制**（2026-10-03 修订：原来免费版限 1 人，取消——见下方说明） |
| 预约/月 | 100 | 不限量* |
| 在线收款/预付定金 | **永久不支持**（2026-10-03 新增规则，见下方 §"在线收款功能") | ✅ |
| 在线预订 | ✅ | ✅ |
| 短信/邮件提醒 | 基础量 | 更高额度 |
| 客户忠诚管理（积分/会员/储值） | ❌ | 完整版 |
| 营销活动（召回/促销模板） | ❌ | ✅ |
| AI 服务 | ❌（可单独加购） | 可加购 |

**免费版员工数量限制取消，2026-10-03（Steven）：** staff rows carry no meaningful variable cost; the 100-booking monthly quota is already the real upgrade trigger. A 1-person cap contradicted this doc's own stated strategy (decision 1 above) — a two-person store well under the booking quota shouldn't be forced to upgrade just because of headcount.

**付费版按门店计费，2026-10-03（Steven）：** `monthly_amount_cents = 49 × (该连锁的 paid store 数量)`，by the Store Module, derived live — not admin-typed. A 1-store chain pays CA$49/month; a 5-store chain pays CA$245/month. The free 100/month quota stays chain-shared, unaffected. Billing account and invoice stay chain-level; only the dollar amount scales with store count. See `groway-billing-workflow.md` for the derivation rule.

**在线收款功能是付费版永久专属，2026-10-03（Steven）：** GATED (paid-only) = anything moving money through the platform — online deposit collection, card pre-authorization, no-show charges. NOT gated = bookkeeping without money movement — price display, marking cash/counter-card as received (free tier keeps this). Standing product rule, recorded now even though deposit collection itself is V1.1+ backlog — see `payment-deposit-preauth-design.md` §1/§5 and `groway-billing-workflow.md`.

`* "不限量"受合理使用政策约束（防薅）。`

**AI 服务（单独加购，不包进订阅）：**

| 服务 | 计费方式（拟） |
|---|---|
| AI 前台（24/7 电话/短信/网页应答、预订） | 按月加购包 |
| AI 填空位（未售 capacity 自动触达客户） | 按成功填补的预约抽成或按量 |
| AI 召回（沉睡客户唤醒） | 按召回成功的预约抽成或按量 |
| AI 语音外呼 | 按分钟/按通，按量 |

> AI 定价铁律：售价 ≥ 3× API/通道成本。先算成本再定价。

## 计费口径（现在定死，以后不扯皮）

- **1 个预约** = 预约记录插入的那一刻即计数一次，按自然月统计。之后无论取消（`cancelled`）还是爽约（`no-show`），都照样计入——空位曾被占用。
- **不计入**：测试预约（staff 标记为测试）。
- **额度按连锁账单账号汇总**：同一连锁名下所有门店的预约量加总计算，不按门店拆分（如某连锁有 N 家店，免费版的 100 次是 N 家店的总和）。
- 超额当月：免费版超 100 后，新预约不可创建（温柔拦截 + 升级提示），而不是事后账单——小连锁最怕 surprise bill。
- 防薅：同一连锁/同一地址限 1 个免费账户；升级/降级按月结算。

## 已确认事项（2026-09-28，不再讨论）

1. **免费版**：有。免费档是既定策略。
2. **免费额度 100 预约/月**：已定为 100，不是 50。单人连锁月均 90–110 单，100 是天然分水岭；2 人以上的店必超，超了就转化。
3. **合伙人自有门店永久免费**：产品归合伙人所有，自己的店用自己的产品不收费。AI、短信、电话等第三方直接成本走合伙人 AWS 账号账单（其信用卡已绑定；Steven 需要 IAM 权限来配置），不计入 CA$2,000/月开发资助。Steven 在本项目中定位为雇员（非创始人），目标是抬高收入下线、不谋求股权与上线收益。
4. **单一付费档**：Studio/Growth 合并为一个"付费版"，CA$49/月（试运行建议价），门店/员工/预约均无限制*。现阶段简单优先，细分等有数据后再说。
5. **试用政策**：付费版首月免费试用 1 个月（细则见"试用政策"节）。
6. **一家店一个管理员账号**：每家门店恰好一个 `store_admin`（operational admin）。`chain_admin` 是一个独立的账户类型（不是某家店 `store_admin` 兼任），一条连锁唯一一个，拥有跨店视图 + 账单管理。**（2026-10-03 修订，reverses the 2026-09-29 decision）** `chain_admin` CAN now manage `store_admin` accounts directly — deactivate them, reset their passwords — no Groway admin needed. Rationale: account lifecycle should follow the HR lifecycle (the chain owner hires/fires store managers); a terminated manager with lingering access is a bigger risk than a `chain_admin` misusing the button, and requiring Groway in the loop doesn't scale. Every such action is logged in the admin activity history; Groway retains break-glass access via the existing impersonation flow. Only `chain_admin` accounts themselves remain Groway-admin-managed. 员工（`staff`）可跨店。

## Plan badges, 2026-10-03（Steven, #7）

Back office visibly distinguishes the chain's plan, derived from billing state at render time — never stored:

| Plan | Badge | Condition |
|---|---|---|
| Free | gray, "Free" | `billing_accounts.plan = 'free'` |
| Paid | brand color, "Paid" | `plan = 'paid'` |
| Paid + AI | distinct (purple + ✨), "Paid + AI" | `plan = 'paid' AND ≥1 active row in ai_addon_subscriptions` |

Shown in: back-office header/sidebar, the billing page, and the Groway admin chain/store list. **Never on any customer-facing surface** — a business's plan tier is never badged to its own customers. Naming is `Free`/`Paid`/`Paid + AI` everywhere, English-only (per #22) — if marketing names are introduced later, they change in one place. Upgrade/downgrade reflects automatically (the badge is derived, not a stored UI state); the same `derive_plan(chain_id)` function is the single source for feature gating (deposits, #17).

`ai_addon_subscriptions` is **documented, not built** in V1 — its shape is undefined until the AI layer gets real design work (zero AI design docs exist by policy until V1 pilot data exists, `V1Backlog.md`). The badge's third tier is correctly specified but unreachable in V1 — only Free/Paid ever actually render.

## 试用政策（已定，2026-09-28）

- 付费版首月免费 1 个月，每连锁限一次。
- 试用无需信用卡；到期提醒：付费订阅，或降回免费版。不搞 surprise bill。
- AI 按量服务不免费试用（有真实第三方成本）；试用期内含小额体验额度（如 50 次 AI 触达），让连锁看到"填了几个空位"，敞口封死。
- 试用期产生的短信/电话/AI 第三方成本，走合伙人 AWS 账号账单，Steven 不经手。

## 待定问题

1. **付费版价格**：CA$49 是试运行建议价，pilot 数据出来后再调（涨价或拆分档位的依据）。
2. **AI 填空位的抽成比例**：Fresha 新客抽 20% 是参照系；AI 填的是本来会浪费的空位，抽 10–15% 连锁可能更愿意接受。待验证。
3. **短信成本**：Twilio 到加拿大的短信单价定下来后，回算各档包含的短信条数。
4. **Marketplace（如果以后做）**：是否跟 Fresha 一样对新客抽成，还是坚持零佣金打差异化。v1 先不做 marketplace，只做 SaaS。
