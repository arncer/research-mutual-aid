-- ============================================================================
-- 序列（DEFAULT nextval 方式；IDENTITY 列由建表语句自动创建，不在此重复）
-- 恢复顺序：本文件 → 10-schema.sql → 20-rls-policies.sql → 90-functions-live.sql → 91-grants.sql
-- 数据导入后需按需 setval，见 docs/RESTORE.md
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS public.email_enqueue_log_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.identity_links_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.institution_journal_subscriptions_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.journal_review_logs_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.journal_submissions_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.journals_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.link_send_log_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.recommendation_batches_id_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.recommendation_items_id_seq START WITH 1 INCREMENT BY 1;

-- 基线时的序列当前值（导出时点，供恢复后对齐）
SELECT setval('public.identity_links_id_seq', 3, true);
SELECT setval('public.institution_journal_subscriptions_id_seq', 11, true);
SELECT setval('public.journal_review_logs_id_seq', 10, true);
SELECT setval('public.journal_submissions_id_seq', 2, true);
SELECT setval('public.journals_id_seq', 5, true);
SELECT setval('public.link_send_log_id_seq', 5, true);
SELECT setval('public.recommendation_batches_id_seq', 7, true);
SELECT setval('public.recommendation_items_id_seq', 35, true);
