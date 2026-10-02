# Groway 设计文档导读

Groway 是一个预约/排班 SaaS 平台，服务对象是美业类门店（美甲、美容、按摩等）。这里的每一份文档，原本都是给技术团队看的设计稿，这份导读把它们翻译成了非技术语言，方便投资人快速了解"这家公司到底在做什么、各个部分之间是怎么衔接的"。

下面的排列顺序，不是这些文档实际被写出来的时间顺序，而是**"如果今天从零开始搭建这套系统，应该先想清楚什么、再想清楚什么"**的逻辑顺序——先有地基，才有上面的房子。

## 一、地基

### [`groway-v1-architecture.md`](groway-v1-architecture.md)
整个系统最底层的技术骨架说明：门店、顾客、平台管理员这三类使用者的系统是怎么分开又怎么连起来的。后面所有文档都建立在这套骨架之上，不会重新解释一遍。

### [`store-onboarding-v1-design.md`](store-onboarding-v1-design.md)
定义了"连锁、门店、技师、服务"这几个最核心的概念到底是什么、彼此怎么关联，是整个系统的核心数据模型。几乎后面每一份文档都在读取或者修改这里定义的数据。

## 二、账户与身份

### [`growayshop-registration-workflow.md`](growayshop-registration-workflow.md)
商家怎么开始使用 Groway：主要路径是老板自己在线填资料、验证邮箱、自动开店，不需要 Groway 的人介入；大客户或特殊情况走人工协助的例外通道。建立在上一份文档定义的"连锁/门店"模型之上。

### [`growayadmin-registration-workflow.md`](growayadmin-registration-workflow.md)
Groway 公司内部员工（平台管理员）自己的账户开通流程，跟商家侧的账户体系是分开的两套。

### [`growayshop-staff-invite-workflow.md`](growayshop-staff-invite-workflow.md)
门店已经开通之后，老板怎么把其他技师、店员邀请进系统。建立在商家账户体系之上。

### [`groway-admin-impersonation-design.md`](groway-admin-impersonation-design.md)
Groway 客服/技术支持在帮商家排查问题时，怎么"借用"商家的视角去操作，同时保证每一步都有记录、商家本人会收到通知，不会被神不知鬼不觉地代做决定。

### [`user-registration-workflow.md`](user-registration-workflow.md)
顾客（预约服务的终端消费者）怎么注册账户——这是跟商家、平台管理员完全独立的第三套身份体系。

## 三、排班与查空档

### [`staff-schedule-entry-workflow.md`](staff-schedule-entry-workflow.md)
门店怎么设置营业时间、技师的工作班表、请假/休息时间——这是"顾客能不能预约到"背后的原始数据来源。

### [`availability-slot-engine.md`](availability-slot-engine.md)
系统怎么根据营业时间、技师班表、已有预约，实时算出"这个时间段到底有没有空"。这是支撑整个预约体验的计算引擎，建立在前面的排班数据之上。

## 四、预约核心引擎

### [`create-appointment-transaction-design.md`](create-appointment-transaction-design.md)
一笔预约到底是怎么被系统"确认下来"的——怎么防止两个顾客抢到同一个时间段、怎么防止重复提交、怎么识别和拦截骚扰性/恶意预约。不管顾客是自己在线下单，还是店员帮忙手动下单，走的都是这同一套核心逻辑，这是保证系统"不会因为入口不同就出现不同规则"的关键设计。

## 五、商业化

### [`pricing-tiers-v1.md`](pricing-tiers-v1.md)
Groway 对商家收费的套餐设计——免费版和付费版分别包含什么、限制在哪里。这是"收费规则"本身，下一份文档讲的是"规则怎么被系统执行出来"。

### [`groway-billing-workflow.md`](groway-billing-workflow.md)
套餐限制怎么在顾客下单的那一刻真正生效（比如免费版用满了会被拦住）、商家快用满额度时怎么提前提醒、商家怎么升级套餐。建立在套餐设计和预约核心引擎之上。

## 六、顾客身份与预约体验

### [`customer-records-design.md`](customer-records-design.md)
顾客的身份信息怎么被系统记录和管理——包括一个从没注册过账户、只是临时留了电话的顾客，后续怎么跟一个正式账户关联起来。

### [`public-booking-end-to-end-design.md`](public-booking-end-to-end-design.md)
顾客在手机/网页上完整的预约体验，从挑选服务、选时间，到最后确认下单——把前面"查空档"、"预约核心引擎"、"顾客身份"这几块拼成一个顾客能实际用上的完整流程。也包含了多店连锁的统一入口链接（一个链接列出所有分店）和"这单生意是哪个社交平台带来的"这项营销效果追踪功能。

### [`staff-manual-booking-calendar-design.md`](staff-manual-booking-calendar-design.md)
门店后台给店员用的排班日历和手动下单界面——比如顾客打电话来约，店员怎么帮忙下单。背后用的是和顾客端完全一样的下单逻辑，只是界面和权限针对店员做了调整。

### [`customer-my-bookings-design.md`](customer-my-bookings-design.md)
顾客自己怎么查看、取消、改期已经约好的预约，不需要店员介入。

## 七、通知提醒

### [`customer-booking-confirmation-reminders-design.md`](customer-booking-confirmation-reminders-design.md)
顾客下单之后，系统怎么发确认短信、怎么在预约前发提醒短信——这是预约核心引擎背后自动触发的一整套通知机制。

### [`groway-store-notifications-workflow.md`](groway-store-notifications-workflow.md)
商家后台的消息提示板——比如套餐额度快用完的提醒、Groway 客服代操作后的告知，都汇总在这里，确保商家不会错过重要信息。

## 八、支付（二期功能）

### [`payment-deposit-preauth-design.md`](payment-deposit-preauth-design.md)
顾客预约时付定金/预授权扣款的设计。这份文档明确标注为"二期功能"，第一期不会上线，目前系统里只预留了一个接口位置，方便以后接入。

## 九、地图与获客

### [`beauty-map-postgis-schema-design.md`](beauty-map-postgis-schema-design.md)
支撑"地图找店"功能的底层地理位置数据设计——建立在门店地址信息之上。

### [`beauty-map-nearby-search-design.md`](beauty-map-nearby-search-design.md)
顾客打开地图之后，系统怎么算出"附近有哪些门店"。建立在上一份文档的地理数据之上。

### [`beauty-map-filtering-design.md`](beauty-map-filtering-design.md)
顾客在地图搜索结果里怎么按服务类型、价格等条件进一步筛选。建立在"附近搜索"功能之上。

### [`beauty-map-ui-design.md`](beauty-map-ui-design.md)
顾客看到的地图搜索页面长什么样、怎么操作——把"附近搜索"和"筛选"这两块拼成一个顾客能实际用上的界面。

## 十、门店与技师展示页

### [`store-profile-enrichment-design.md`](store-profile-enrichment-design.md)
门店的详情页展示内容——店铺介绍、照片、规章须知、评价。顾客通常是从地图搜索结果点进来看到这一页。

### [`staff-profile-design.md`](staff-profile-design.md)
技师个人的展示页——简介、照片、会说的语言、服务过的顾客数据。第一版先上线公开主页本身，内容由店长/老板代为录入；技师自己动手编辑、提交后等审核通过才生效的那套自助流程，留到下一阶段上线。

## 十一、未来规划

### [`V1Backlog.md`](V1Backlog.md)
记录了目前还没做、但已经想清楚方向的功能点，覆盖以上所有模块。放在最后，是因为它是"接下来要做什么"，不是现在这套系统运转所必须依赖的东西。
