# 基线之后的数据库变更（2026-10-26 基线 → 2026-10-30）

本目录的 `00`~`91` 脚本为 2026-10-26 导出的基线。此后在生产库上还做了以下变更，
新环境重建时需在基线脚本之后依次应用。

## 1. 表结构增量

```sql
-- 邮件队列：补充投递阶段、SMTP 响应码、锁与提交时间
ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS smtp_code text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- 入队日志：关联队列 ID 与阶段
ALTER TABLE email_enqueue_log
  ADD COLUMN IF NOT EXISTS outbox_id bigint,
  ADD COLUMN IF NOT EXISTS stage text;

-- 云端凭据库：SMTP 配置（授权码只存此处，不进代码与日志）
ALTER TABLE app_secret
  ADD COLUMN IF NOT EXISTS smtp_host text,
  ADD COLUMN IF NOT EXISTS smtp_port integer,
  ADD COLUMN IF NOT EXISTS smtp_secure boolean,
  ADD COLUMN IF NOT EXISTS smtp_user text,
  ADD COLUMN IF NOT EXISTS smtp_pass text,
  ADD COLUMN IF NOT EXISTS smtp_from text;
```

## 2. 新增 / 重写函数

| 函数 | 用途 | 权限要点 |
| --- | --- | --- |
| `whoami()` | 一次调用返回 uid 与是否管理员；匿名 `auth.uid()='anon'` 视作未登录 | `SECURITY DEFINER`，GRANT 给 anon/authenticated |
| `is_admin()` | 改为 `SECURITY DEFINER`，避免 `admins` 表 RLS 屏蔽判定 | 同上 |
| `admin_get_smtp_status()` | 管理员读取脱敏配置状态（只回 `passSet`/长度，不回明文） | 仅管理员 |
| `admin_save_smtp_config(...)` | 管理员保存 SMTP；host 格式校验、端口白名单（25/465/587/994/2525）；pass 留空表示不变 | 仅管理员 |
| `worker_get_smtp_secret(text)` | 服务端投递器凭 workerSecret 取凭据，未配置返回 `configured:false` | workerSecret 守卫 + GRANT anon（RPC 走 anon 角色） |
| `upload_attachment(...)`（重写） | 增加 `uid='anon'` 拒绝、无邮箱写 `skipped_no_email`、dedupe 防重复提醒 | 仅登录用户 |
| `claim_emails(...)`（重写） | 回收 `sending` 状态超过 5 分钟的僵尸任务 | workerSecret 守卫 |
| `finish_email(...)`（重写） | 增加 `p_stage` / `p_smtp_code` 两个参数 | workerSecret 守卫 |
| `email_outbox_recent(...)` | 管理员查看最近投递记录 | workerSecret 守卫 |

## 3. 期刊模块（约 30 个函数）

`journal_search` / `journal_detail` / `journal_import*` / `journal_admin_*` /
`submit_journal_subscription` / `admin_upsert_subscription` 等，已在基线脚本
`90-functions-live.sql` 中体现（基线导出时点已包含）。

## 4. 如何导出当前完整函数定义

基线脚本可能落后于生产库。需要最新定义时，在云端数据库执行：

```sql
SELECT string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' ORDER BY p.proname)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f';
```

结果较大，建议按函数名分片导出（例如按首字母分 2~4 段）。
