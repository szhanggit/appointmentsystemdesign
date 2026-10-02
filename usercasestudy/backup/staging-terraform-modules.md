# Staging — Terraform 模块清单（4 天）

对应 `staging-architecture.html` 的搭建计划。全部模块放 `terraform/`，staging 取值集中在
`environments/staging/terraform.tfvars`。约定：模块只建资源，不写业务数据；
PostGIS extension、KEDA ScaledObject 由应用侧 migration/manifest 负责（文末注明）。

## 目录结构

```
terraform/
├── environments/
│   └── staging/
│       ├── main.tf          # 组装 modules，staging 传参
│       ├── variables.tf
│       └── terraform.tfvars # staging 取值（单 AZ、小规格）
└── modules/
    ├── network/       # Day 1
    ├── eks/           # Day 1
    ├── ecr/           # Day 1（先建仓库，CI 才有地方推）
    ├── database/      # Day 2
    ├── cache/         # Day 2
    ├── messaging/     # Day 2
    ├── secrets/       # Day 2
    ├── identity/      # Day 3
    ├── notifications/ # Day 3
    ├── frontend/      # Day 3
    └── ingress/       # Day 3
```

## Day 1 — 网络 + EKS + ECR

**modules/network**
- `aws_vpc`（10.0.0.0/16），公网/私网子网 ×2 AZ（staging 省成本：子网跨 2 AZ，NAT 只建 1 个）
- `aws_nat_gateway`（单个）+ 公网/私网路由表
- VPC endpoints：ECR、SQS、Secrets Manager（私网子网调 AWS 服务不走 NAT，省流量费）
- 输出：`vpc_id`、`public_subnet_ids`、`private_subnet_ids`

**modules/eks**
- `aws_eks_cluster`（1.29+），`aws_eks_node_group`（t3.medium ×2，staging 最小可用）
- IRSA：OIDC provider + `aws_iam_role`（给 Gateway 用的 SQS/SecretsManager 权限）
- `helm_release`：AWS Load Balancer Controller、KEDA operator
- 输出：`cluster_name`、`oidc_provider_arn`、`gateway_irsa_role_arn`

**modules/ecr**
- `aws_ecr_repository`：`groway/gateway`（消费者跟 Gateway 同镜像，KEDA 部署只换启动参数——架构文档 §8 是一个进程，三个消费者 Deployment 跑同一个镜像的不同 entrypoint）
- 生命周期策略：staging 只留最近 10 个 tag

## Day 2 — 数据 + 消息 + 密钥

**modules/database**
- `aws_db_subnet_group`（私网子网），`aws_db_instance`：Postgres 16、db.t3.small、**单 AZ**、gp3 20GB、自动小版本升级开、备份保留 7 天（staging）
- 安全组：只放 EKS 节点安全组进 5432
- 输出：`db_endpoint`、`db_name`；**PostGIS 不在这里装**——由 EF migration 执行 `CREATE EXTENSION postgis`（应用侧，DBA 习惯）

**modules/cache**
- `aws_elasticache_replication_group`：Redis 7、单节点 t3.micro（staging；prod 才开多副本）、无 at-rest 加密取舍可开（staging 建议照开，零成本）
- 输出：`redis_endpoint`

**modules/messaging**
- `aws_sqs_queue` ×3：`customer-activity-log`、`store-activity-log`、`admin-activity-log`（标准队列，14 天保留 staging 取 4 天亦可）
- 每个配 `aws_sqs_queue` DLQ + `redrive_policy`（maxReceiveCount=5）
- 输出：三个 queue_url（写进 Secrets / KEDA ScaledObject 用）

**modules/secrets**
- `aws_secretsmanager_secret` + `random_password`：DB 主密码
- 空 secret 占位：`groway/staging/app`（CI 部署时由 workflow 写入拼接好的连接串，Terraform 不碰应用配置值）
- 输出：secret ARNs（IRSA role 加读权限）

## Day 3 — 身份 + 通知 + 前端 + 入口

**modules/identity**
- `aws_cognito_user_pool` ×3：customer（自定义认证：Define/Create/Verify Auth Challenge 三个 Lambda）、store、admin（邀请制）
- `aws_cognito_user_pool_client` ×3（给 Gateway 用的服务端 client，带 secret）
- `aws_lambda_function` ×3（customer 池 triggers，.NET 或 Node 二选一，staging 推荐 Node——冷启动快、代码少）+ `aws_lambda_permission`（允许 Cognito 调用）
- 输出：三个 pool_id、client_id（client secret 进 Secrets Manager）

**modules/notifications**
- Cognito 发短信走它自己的 SNS 集成：`aws_iam_role`（`sns:Publish`，给 Cognito 用）——注意这是 Cognito 服务角色，不是 SQS 那个 topic
- `aws_ses_domain_identity` + DKIM（`aws_ses_domain_dkim`），Cognito 邮件发件人用 SES
- 输出：已验证域名（发件人邮箱域名需提前过户/DNS 验证）

**modules/frontend**
- `aws_s3_bucket`（SPA 产物，私有桶）+ `aws_cloudfront_distribution`（OAC 回源 S3，默认根对象 index.html，SPA 错误页回退 404→index.html）
- `aws_acm_certificate`（us-east-1，CloudFront 要求）+ `aws_route53_record`（staging.groway.ca 示例，占位符，tfvars 里换）
- 输出：distribution 域名、staging URL

**modules/ingress**
- `kubernetes_ingress_v1`：host=api.staging.groway.ca → Gateway Service（`alb.ingress.kubernetes.io/scheme: internet-facing`）
- ACM 证书 ARN 注解在 ALB listener 上（`aws_acm_certificate` 同 frontend 模块复用，或本模块自建——二选一，main.tf 里定死用 frontend 的输出）

## Day 4 — CI/CD（GitHub Actions，不是 Terraform）

- `.github/workflows/build.yml`：`dotnet build/test` → `docker buildx` → 推 ECR（tag=sha）
- `.github/workflows/deploy-staging.yml`：kustomize 渲染（镜像 tag 替换）→ `kubectl apply` → `rollout status` → 冒烟：`GET /health`、Cognito 登录冒烟、nearby 接口冒烟
- ECR 登录用 OIDC（`aws-actions/configure-aws-credentials` + IRSA 风格的 GitHub OIDC role，**不存 AK/SK**）
- 冒烟失败 → workflow 标红，不自动回滚（staging 手动 `kubectl rollout undo`，1 条命令）

## 不在 Terraform 里的（应用侧负责）

1. `CREATE EXTENSION postgis;` + `geo` 列/trigger/index —— EF migration（见 `beauty-map-postgis-schema.md` §2）
2. KEDA `ScaledObject` ×3（队列名来自 Terraform 输出，写进 k8s manifest）
3. Cognito 用户池里的 app client 回调 URL、SES 发件人邮箱内容
4. Mapbox token（前端 public token 直接嵌 SPA 环境变量；geocoding secret 进 Secrets Manager）

## staging tfvars 关键取值（一览）

| 项 | staging 值 | prod 差异 |
|---|---|---|
| RDS | db.t3.small，单 AZ | Multi-AZ，db.m6i.large+ |
| Redis | 单节点 t3.micro | 多副本 + 故障转移 |
| NAT | 1 个 | 每 AZ 1 个 |
| EKS 节点 | t3.medium ×2 | 按负载，ASG |
| SQS 保留 | 4 天 | 14 天 |
| WAF | 无 | 有 |
| 备份 | RDS 7 天 | 30 天 + 跨区 |
