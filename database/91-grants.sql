-- =====================================================================
-- 科研互助平台 · 权限（GRANT / REVOKE）基线
-- 生成方式：从活库 pg_class.relacl / pg_proc.proacl 直接读取（2026-10-26 基线）
-- 执行顺序：在 10-schema.sql、20-rls-policies.sql、90-functions-live.sql 之后执行
-- 说明：本文件只还原权限，不改任何数据；可重复执行（幂等）
-- 角色：anon（未登录）、authenticated（已登录）、service_role（服务端）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 一、数据表权限
-- ---------------------------------------------------------------------
-- 先统一收回，避免默认 PUBLIC/历史授权残留
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- A 组：anon 只读，登录用户全权限（10 张）
-- admins / app_secret / attachment_files / bans / email_outbox /
-- email_verify_codes / notifications / profiles / review_tasks / violations
GRANT SELECT ON TABLE
  public.admins, public.app_secret, public.attachment_files, public.bans,
  public.email_outbox, public.email_verify_codes, public.notifications,
  public.profiles, public.review_tasks, public.violations
TO anon;
GRANT ALL PRIVILEGES ON TABLE
  public.admins, public.app_secret, public.attachment_files, public.bans,
  public.email_outbox, public.email_verify_codes, public.notifications,
  public.profiles, public.review_tasks, public.violations
TO authenticated, service_role;

-- B 组：anon 可读写（依赖 RLS 做实际约束），登录用户全权限（4 张）
-- attachments / help_requests / papers / universities
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.attachments, public.help_requests, public.papers, public.universities
TO anon;
GRANT ALL PRIVILEGES ON TABLE
  public.attachments, public.help_requests, public.papers, public.universities
TO authenticated, service_role;

-- C 组：仅服务端可访问（10 张，anon / authenticated 全部收回，靠 SECURITY DEFINER 函数间接访问）
-- email_enqueue_log / identity_links / institution_journal_subscriptions /
-- journal_review_logs / journal_submissions / journals / link_send_log /
-- point_legacy_users / recommendation_batches / recommendation_items
GRANT ALL PRIVILEGES ON TABLE
  public.email_enqueue_log, public.identity_links,
  public.institution_journal_subscriptions, public.journal_review_logs,
  public.journal_submissions, public.journals, public.link_send_log,
  public.point_legacy_users, public.recommendation_batches,
  public.recommendation_items
TO service_role;

-- D 组：积分账本仅服务端可写（2 张）
-- anon = SELECT；authenticated = SELECT + REFERENCES + TRIGGER（不可直接改余额或流水）
GRANT SELECT ON TABLE public.point_accounts, public.point_transactions TO anon;
GRANT SELECT, REFERENCES, TRIGGER ON TABLE
  public.point_accounts, public.point_transactions
TO authenticated;
GRANT ALL PRIVILEGES ON TABLE
  public.point_accounts, public.point_transactions
TO service_role;

-- E 组：review_logs —— anon 可插入流水（配合 RLS），不可改历史
GRANT SELECT, INSERT ON TABLE public.review_logs TO anon;
GRANT ALL PRIVILEGES ON TABLE public.review_logs TO authenticated, service_role;

-- F 组：subscriptions —— anon 可插入订阅申请，不可删除
GRANT SELECT, INSERT, DELETE ON TABLE public.subscriptions TO anon;
GRANT ALL PRIVILEGES ON TABLE public.subscriptions TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 二、序列权限（identity 列与 nextval 默认值需要 USAGE）
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 公开序列（14 个）：anon / authenticated / service_role 均为 rwU
GRANT USAGE, SELECT, UPDATE ON SEQUENCE
  public.attachments_id_seq, public.bans_id_seq, public.email_enqueue_log_id_seq,
  public.email_outbox_id_seq, public.email_verify_codes_id_seq,
  public.help_requests_id_seq, public.notifications_id_seq, public.papers_id_seq,
  public.point_transactions_id_seq, public.review_logs_id_seq,
  public.review_tasks_id_seq, public.subscriptions_id_seq,
  public.universities_id_seq, public.violations_id_seq
TO anon, authenticated, service_role;

-- 内部序列（8 个）：仅 service_role
GRANT USAGE, SELECT, UPDATE ON SEQUENCE
  public.identity_links_id_seq, public.institution_journal_subscriptions_id_seq,
  public.journal_review_logs_id_seq, public.journal_submissions_id_seq,
  public.journals_id_seq, public.link_send_log_id_seq,
  public.recommendation_batches_id_seq, public.recommendation_items_id_seq
TO service_role;

-- ---------------------------------------------------------------------
-- 三、函数权限
-- ---------------------------------------------------------------------
-- 第一步：全部收回 PUBLIC 的默认 EXECUTE（PostgreSQL 默认给 PUBLIC 执行权）
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- 第二步：业务 RPC —— anon / authenticated 可调用（函数内部自行校验 auth.uid() 与角色）
GRANT EXECUTE ON FUNCTION
  public.admin_journal_logs(integer),
  public.admin_list_journal_submissions(text, integer),
  public.admin_list_journals(text, integer),
  public.admin_list_subscriptions(bigint, text, text, integer),
  public.admin_merge_journals(bigint, bigint, text),
  public.admin_review_attachment(bigint, text, text, text),
  public.admin_review_journal_submission(bigint, text, text, text, text, text, text, text),
  public.admin_revoke_subscription(bigint, text),
  public.admin_upsert_subscription(bigint, text, bigint, text, text, text, text, text, text, text, text, text, text, boolean),
  public.bind_identity(text, text, text, text),
  public.claim_emails(text, integer),
  public.claim_link_send(text, text, text, text),
  public.cleanup_expired_files(),
  public.confirm_email_bind(text, text),
  public.create_request_with_bounty(bigint, text, text, text, text, text, integer, text, text, text, text, text, text, text),
  public.daily_checkin(),
  public.daily_helper_leaderboard(integer),
  public.delete_my_request_with_refund(bigint),
  public.email_outbox_recent(text, integer),
  public.ensure_email_bind_notice(),
  public.ensure_my_points(),
  public.finish_email(text, bigint, boolean, text),
  public.is_admin(),
  public.link_precheck(text, text, text, text),
  public.mark_password_set(),
  public.my_journal_catalog(text, integer),
  public.my_journal_submissions(integer),
  public.my_login_state(),
  public.my_points_overview(),
  public.my_recommend_setting(),
  public.my_requests_sorted(integer, integer),
  public.my_today_recommendations(),
  public.my_university(),
  public.norm_journal_title(text),
  public.platform_stats(),
  public.reco_items_json(bigint),
  public.record_file_delete_result(bigint, boolean, text),
  public.request_email_bind(text),
  public.resolve_journal(text, text, text, text, text, text),
  public.review_attachment(bigint, text, text, text),
  public.search_universities(text, text, integer),
  public.set_my_nickname(text),
  public.set_my_recommend_setting(boolean, text),
  public.set_my_university(bigint, text, text, text, text, text, text),
  public.set_request_status(bigint, text),
  public.square_list(text, integer, integer),
  public.submit_journal_subscription(text, text, text, text, text, text, text, text, text, text, text),
  public.sync_session_email(),
  public.update_journal_submission(bigint, text, text, text, text, text, text, text, text, text, text, text),
  public.upload_attachment(bigint, text, text, bigint, text, text, text, text),
  public.withdraw_journal_submission(bigint)
TO anon, authenticated, service_role;

-- 第三步：仅服务端可调用（不可由浏览器直接触发：邮件入队、积分记账、身份归一化、登录态查询）
GRANT EXECUTE ON FUNCTION
  public.enqueue_email(text, text, bigint, bigint, text, text, text, text),
  public.login_state_for(text),
  public.mark_my_email(text),
  public.norm_identity(text, text),
  public.point_grant(text, text, integer, text, bigint, bigint, text)
TO service_role;

-- 触发器函数：只由触发器调用，任何客户端角色都不直接执行
REVOKE ALL ON FUNCTION public.trg_help_request_bounty_guard() FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 四、恢复后自检（可选，手工核对用）
-- 期望：tables=28 / sequences=22 / 有 EXECUTE 的函数=56（trg_ 触发器函数除外）
-- =====================================================================
-- SELECT c.relname, c.relkind,
--        coalesce(array_to_string(c.relacl, ' | '), '(default)') AS acl
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')
--  ORDER BY c.relkind DESC, c.relname;
--
-- SELECT p.proname,
--        coalesce(array_to_string(p.proacl, ' | '), '(default: PUBLIC EXECUTE)') AS acl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--  ORDER BY p.proname;
