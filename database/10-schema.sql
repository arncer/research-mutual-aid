-- ============================================================================
-- 科研互助平台 · 数据库结构基线（2026-10-26）
-- 来源：生产库 information_schema / pg_catalog 导出，非人工手写
-- 内容：序列 → 表（含 IDENTITY）→ 主键/外键/检查约束 → 索引
--       → 行级安全（RLS）策略 → 触发器 → 函数权限
-- 用法：在空库按本文件顺序执行，随后执行 91-grants.sql、90-functions-live.sql
-- 注意：所有业务函数均为 SECURITY DEFINER 且 SET search_path，权限已单独收紧
-- ============================================================================

-- ---------- 1. 表 ----------
CREATE TABLE public.admins (user_id text NOT NULL, note text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.app_secret (id integer NOT NULL DEFAULT 1, worker_secret text NOT NULL, updated_at timestamp with time zone NOT NULL DEFAULT now(), public_base_url text, share_code text);
CREATE TABLE public.attachment_files (attachment_id bigint NOT NULL, file_path text NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.attachments (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, owner_id text NOT NULL DEFAULT auth.uid(), owner_name text, request_id bigint NOT NULL, file_name text NOT NULL, file_path text, size_bytes bigint, status text NOT NULL DEFAULT 'pending'::text, review_note text, reviewed_by text, reviewed_at timestamp with time zone, oa_source_url text, license_type text, license_note text, share_confirmed boolean NOT NULL DEFAULT false, created_at timestamp with time zone NOT NULL DEFAULT now(), expires_at timestamp with time zone, file_delete_attempts integer NOT NULL DEFAULT 0, file_delete_error text);
CREATE TABLE public.bans (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, user_id text NOT NULL, starts_at timestamp with time zone NOT NULL DEFAULT now(), ends_at timestamp with time zone NOT NULL, reason text, created_at timestamp with time zone NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT true);
CREATE TABLE public.email_enqueue_log (id bigint NOT NULL DEFAULT nextval('email_enqueue_log_id_seq'::regclass), request_id bigint, attachment_id bigint, recipient_id text, recipient_email text, kind text, error text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.email_outbox (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, recipient_id text NOT NULL, recipient_email text NOT NULL, request_id bigint, attachment_id bigint, kind text NOT NULL, subject text NOT NULL, body text NOT NULL, status text NOT NULL DEFAULT 'pending'::text, attempts integer NOT NULL DEFAULT 0, last_error text, dedupe_key text NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now(), sent_at timestamp with time zone);
CREATE TABLE public.email_verify_codes (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, user_id text NOT NULL, email text NOT NULL, purpose text NOT NULL DEFAULT 'bind_email'::text, code_hash text NOT NULL, salt text NOT NULL, attempts integer NOT NULL DEFAULT 0, consumed_at timestamp with time zone, expires_at timestamp with time zone NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.help_requests (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, owner_id text NOT NULL DEFAULT auth.uid(), owner_name text, paper_id bigint, doi text, paper_title text, description text, status text NOT NULL DEFAULT 'open'::text, oa_link text, license_type text, license_note text, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), completed_by text, completed_at timestamp with time zone, authors text, journal text, journal_type text, published_year integer, volume text, issue text, pages text, publisher text, source_url text, bounty_points integer NOT NULL DEFAULT 0, bounty_status text NOT NULL DEFAULT 'none'::text, bounty_locked_at timestamp with time zone, bounty_paid_at timestamp with time zone, bounty_paid_to text, bounty_refunded_at timestamp with time zone, file_expires_at timestamp with time zone, invalid_reason text, file_deleted_at timestamp with time zone, file_cleanup_status text NOT NULL DEFAULT 'none'::text);
CREATE TABLE public.identity_links (id bigint NOT NULL DEFAULT nextval('identity_links_id_seq'::regclass), user_id text NOT NULL, kind text NOT NULL, value text NOT NULL, action text NOT NULL DEFAULT 'bind'::text, note text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.institution_journal_subscriptions (id bigint NOT NULL DEFAULT nextval('institution_journal_subscriptions_id_seq'::regclass), university_id bigint NOT NULL, journal_id bigint NOT NULL, status text NOT NULL DEFAULT 'pending'::text, database_name text, coverage_scope text, coverage_years text, coverage_from_year integer, coverage_to_year integer, source_type text, source_url text, evidence_note text, reviewer_id text, reviewer_name text, reviewed_at timestamp with time zone, is_demo boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, submission_id bigint, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.journal_review_logs (id bigint NOT NULL DEFAULT nextval('journal_review_logs_id_seq'::regclass), submission_id bigint, subscription_id bigint, journal_id bigint, university_id bigint, action text NOT NULL, note text, reviewer_id text, reviewer_name text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.journal_submissions (id bigint NOT NULL DEFAULT nextval('journal_submissions_id_seq'::regclass), submitter_id text NOT NULL, submitter_name text, university_id bigint NOT NULL, university_name text, journal_id bigint, journal_title text NOT NULL, issn text, eissn text, publisher text, subject text, database_name text, coverage_years text, coverage_scope text, library_url text, evidence_note text, remark text, status text NOT NULL DEFAULT 'pending'::text, admin_note text, reviewed_by text, reviewer_name text, reviewed_at timestamp with time zone, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.journals (id bigint NOT NULL DEFAULT nextval('journals_id_seq'::regclass), title text NOT NULL, title_norm text NOT NULL, issn text, eissn text, publisher text, subject text, official_url text, aliases text, note text, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.link_send_log (id bigint NOT NULL DEFAULT nextval('link_send_log_id_seq'::regclass), kind text NOT NULL, value text NOT NULL, user_id text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.notifications (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, recipient_id text NOT NULL, sender_id text DEFAULT auth.uid(), title text NOT NULL, content text, is_read boolean NOT NULL DEFAULT false, created_at timestamp with time zone NOT NULL DEFAULT now(), request_id bigint);
CREATE TABLE public.papers (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, doi text, title text, authors text, journal text, publisher text, published_year integer, doi_url text, oa_url text, license text, fetched_by text DEFAULT auth.uid(), created_at timestamp with time zone NOT NULL DEFAULT now(), journal_type text, volume text, issue text, pages text, source_url text, issn text);
CREATE TABLE public.point_accounts (user_id text NOT NULL DEFAULT auth.uid(), balance integer NOT NULL DEFAULT 0, total_earned integer NOT NULL DEFAULT 0, total_spent integer NOT NULL DEFAULT 0, help_earned integer NOT NULL DEFAULT 0, help_count integer NOT NULL DEFAULT 0, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.point_legacy_users (user_id text NOT NULL, granted_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.point_transactions (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, user_id text NOT NULL, type text NOT NULL, amount integer NOT NULL, balance_before integer NOT NULL, balance_after integer NOT NULL, request_id bigint, attachment_id bigint, dedupe_key text NOT NULL, note text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.profiles (user_id text NOT NULL, nickname text, updated_at timestamp with time zone NOT NULL DEFAULT now(), university_id bigint, university_name text, university_country text, university_type text, college text, major text, university_verified boolean NOT NULL DEFAULT true, university_visibility text NOT NULL DEFAULT 'private'::text, has_password boolean NOT NULL DEFAULT false, email text, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamp with time zone, phone text, phone_verified boolean NOT NULL DEFAULT false, phone_verified_at timestamp with time zone, daily_recommend_enabled boolean NOT NULL DEFAULT false, daily_recommend_updated_at timestamp with time zone, recommend_subjects text);
CREATE TABLE public.recommendation_batches (id bigint NOT NULL DEFAULT nextval('recommendation_batches_id_seq'::regclass), user_id text NOT NULL, batch_date date NOT NULL, university_id bigint, journal_count integer NOT NULL DEFAULT 0, major_count integer NOT NULL DEFAULT 0, other_count integer NOT NULL DEFAULT 0, total_count integer NOT NULL DEFAULT 0, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.recommendation_items (id bigint NOT NULL DEFAULT nextval('recommendation_items_id_seq'::regclass), batch_id bigint NOT NULL, request_id bigint NOT NULL, rank integer NOT NULL, match_type text NOT NULL, reason text NOT NULL, subscription_id bigint, journal_id bigint, is_demo boolean NOT NULL DEFAULT false, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.review_logs (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, attachment_id bigint NOT NULL, reviewer_id text NOT NULL DEFAULT auth.uid(), reviewer_name text, action text NOT NULL, note text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.review_tasks (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, request_id bigint NOT NULL, attachment_id bigint NOT NULL, requester_note text, created_at timestamp with time zone NOT NULL DEFAULT now(), resolved_at timestamp with time zone, resolved_by text, resolution text, admin_note text);
CREATE TABLE public.subscriptions (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, owner_id text NOT NULL DEFAULT auth.uid(), university_id bigint NOT NULL, note text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.universities (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, name text NOT NULL, domain text, note text, created_at timestamp with time zone NOT NULL DEFAULT now(), country text NOT NULL DEFAULT '中国'::text, region text, type text, is_verified boolean NOT NULL DEFAULT true, source text NOT NULL DEFAULT 'seed'::text);
CREATE TABLE public.violations (id bigint NOT NULL GENERATED ALWAYS AS IDENTITY, user_id text NOT NULL, attachment_id bigint, request_id bigint, reason text, created_at timestamp with time zone NOT NULL DEFAULT now(), dedupe_key text NOT NULL);

-- ---------- 2. 主键 / 唯一 / 外键 / 检查约束 ----------
ALTER TABLE public.admins ADD CONSTRAINT admins_pkey PRIMARY KEY (user_id);
ALTER TABLE public.app_secret ADD CONSTRAINT app_secret_pkey PRIMARY KEY (id);
ALTER TABLE public.app_secret ADD CONSTRAINT app_secret_single_row CHECK ((id = 1));
ALTER TABLE public.attachment_files ADD CONSTRAINT attachment_files_pkey PRIMARY KEY (attachment_id);
ALTER TABLE public.attachment_files ADD CONSTRAINT attachment_files_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE;
ALTER TABLE public.attachments ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);
ALTER TABLE public.attachments ADD CONSTRAINT attachments_request_id_fkey FOREIGN KEY (request_id) REFERENCES help_requests(id);
ALTER TABLE public.bans ADD CONSTRAINT bans_pkey PRIMARY KEY (id);
ALTER TABLE public.email_enqueue_log ADD CONSTRAINT email_enqueue_log_pkey PRIMARY KEY (id);
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_dedupe_key_key UNIQUE (dedupe_key);
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL;
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_request_id_fkey FOREIGN KEY (request_id) REFERENCES help_requests(id) ON DELETE SET NULL;
ALTER TABLE public.email_verify_codes ADD CONSTRAINT email_verify_codes_pkey PRIMARY KEY (id);
ALTER TABLE public.help_requests ADD CONSTRAINT help_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.help_requests ADD CONSTRAINT help_requests_paper_id_fkey FOREIGN KEY (paper_id) REFERENCES papers(id);
ALTER TABLE public.help_requests ADD CONSTRAINT help_requests_bounty_status_check CHECK ((bounty_status = ANY (ARRAY['none'::text, 'locked'::text, 'paid'::text, 'refunded'::text])));
ALTER TABLE public.identity_links ADD CONSTRAINT identity_links_pkey PRIMARY KEY (id);
ALTER TABLE public.identity_links ADD CONSTRAINT identity_links_kind_check CHECK ((kind = ANY (ARRAY['email'::text, 'phone'::text])));
ALTER TABLE public.institution_journal_subscriptions ADD CONSTRAINT institution_journal_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE public.institution_journal_subscriptions ADD CONSTRAINT institution_journal_subscriptions_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES journals(id) ON DELETE CASCADE;
ALTER TABLE public.institution_journal_subscriptions ADD CONSTRAINT institution_journal_subscriptions_university_id_fkey FOREIGN KEY (university_id) REFERENCES universities(id) ON DELETE CASCADE;
ALTER TABLE public.institution_journal_subscriptions ADD CONSTRAINT institution_journal_subscriptions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'database_only'::text, 'verified'::text, 'revoked'::text])));
ALTER TABLE public.journal_review_logs ADD CONSTRAINT journal_review_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.journal_submissions ADD CONSTRAINT journal_submissions_pkey PRIMARY KEY (id);
ALTER TABLE public.journal_submissions ADD CONSTRAINT journal_submissions_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES journals(id);
ALTER TABLE public.journal_submissions ADD CONSTRAINT journal_submissions_university_id_fkey FOREIGN KEY (university_id) REFERENCES universities(id);
ALTER TABLE public.journal_submissions ADD CONSTRAINT journal_submissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'need_info'::text, 'withdrawn'::text])));
ALTER TABLE public.journals ADD CONSTRAINT journals_pkey PRIMARY KEY (id);
ALTER TABLE public.link_send_log ADD CONSTRAINT link_send_log_pkey PRIMARY KEY (id);
ALTER TABLE public.link_send_log ADD CONSTRAINT link_send_log_kind_check CHECK ((kind = ANY (ARRAY['email'::text, 'phone'::text])));
ALTER TABLE public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_request_id_fkey FOREIGN KEY (request_id) REFERENCES help_requests(id) ON DELETE SET NULL;
ALTER TABLE public.papers ADD CONSTRAINT papers_pkey PRIMARY KEY (id);
ALTER TABLE public.papers ADD CONSTRAINT papers_doi_key UNIQUE (doi);
ALTER TABLE public.point_accounts ADD CONSTRAINT point_accounts_pkey PRIMARY KEY (user_id);
ALTER TABLE public.point_accounts ADD CONSTRAINT point_accounts_balance_check CHECK ((balance >= 0));
ALTER TABLE public.point_legacy_users ADD CONSTRAINT point_legacy_users_pkey PRIMARY KEY (user_id);
ALTER TABLE public.point_transactions ADD CONSTRAINT point_transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.point_transactions ADD CONSTRAINT point_transactions_dedupe_key_key UNIQUE (dedupe_key);
ALTER TABLE public.point_transactions ADD CONSTRAINT point_transactions_amount_check CHECK ((amount <> 0));
ALTER TABLE public.point_transactions ADD CONSTRAINT point_transactions_balance_after_check CHECK ((balance_after >= 0));
ALTER TABLE public.point_transactions ADD CONSTRAINT point_transactions_check CHECK ((balance_after = (balance_before + amount)));
ALTER TABLE public.point_transactions ADD CONSTRAINT point_transactions_type_check CHECK ((type = ANY (ARRAY['signup_bonus'::text, 'legacy_initial_grant'::text, 'daily_checkin'::text, 'bounty_lock'::text, 'bounty_reward'::text, 'bounty_refund'::text])));
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);
ALTER TABLE public.recommendation_batches ADD CONSTRAINT recommendation_batches_pkey PRIMARY KEY (id);
ALTER TABLE public.recommendation_batches ADD CONSTRAINT recommendation_batches_user_id_batch_date_key UNIQUE (user_id, batch_date);
ALTER TABLE public.recommendation_items ADD CONSTRAINT recommendation_items_pkey PRIMARY KEY (id);
ALTER TABLE public.recommendation_items ADD CONSTRAINT recommendation_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES recommendation_batches(id) ON DELETE CASCADE;
ALTER TABLE public.recommendation_items ADD CONSTRAINT recommendation_items_batch_id_request_id_key UNIQUE (batch_id, request_id);
ALTER TABLE public.recommendation_items ADD CONSTRAINT recommendation_items_match_type_check CHECK ((match_type = ANY (ARRAY['journal'::text, 'major'::text, 'other'::text])));
ALTER TABLE public.review_logs ADD CONSTRAINT review_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.review_logs ADD CONSTRAINT review_logs_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES attachments(id);
ALTER TABLE public.review_tasks ADD CONSTRAINT review_tasks_pkey PRIMARY KEY (id);
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_university_id_fkey FOREIGN KEY (university_id) REFERENCES universities(id);
ALTER TABLE public.universities ADD CONSTRAINT universities_pkey PRIMARY KEY (id);
ALTER TABLE public.universities ADD CONSTRAINT universities_name_key UNIQUE (name);
ALTER TABLE public.violations ADD CONSTRAINT violations_pkey PRIMARY KEY (id);
ALTER TABLE public.violations ADD CONSTRAINT violations_dedupe_key_key UNIQUE (dedupe_key);

-- ---------- 3. 索引（约束之外的业务索引） ----------
CREATE INDEX idx_attachments_request ON public.attachments USING btree (request_id);
CREATE UNIQUE INDEX one_pending_attachment_per_request ON public.attachments USING btree (request_id) WHERE (status = ANY (ARRAY['pending'::text, 'rejected_by_requester'::text]));
CREATE INDEX email_outbox_status_idx ON public.email_outbox USING btree (status, created_at);
CREATE INDEX idx_help_requests_doi ON public.help_requests USING btree (doi);
CREATE INDEX idx_help_requests_status ON public.help_requests USING btree (status);
CREATE UNIQUE INDEX ijs_uni_journal_uniq ON public.institution_journal_subscriptions USING btree (university_id, journal_id);
CREATE INDEX ijs_uni_status_idx ON public.institution_journal_subscriptions USING btree (university_id, status) WHERE is_active;
CREATE INDEX journal_submissions_status_idx ON public.journal_submissions USING btree (status, created_at DESC);
CREATE INDEX journal_submissions_submitter_idx ON public.journal_submissions USING btree (submitter_id, created_at DESC);
CREATE UNIQUE INDEX journals_issn_uniq ON public.journals USING btree (issn) WHERE (issn IS NOT NULL);
CREATE UNIQUE INDEX journals_title_norm_uniq ON public.journals USING btree (title_norm);
CREATE INDEX link_send_log_value_idx ON public.link_send_log USING btree (kind, value, created_at DESC);
CREATE INDEX idx_notifications_recipient ON public.notifications USING btree (recipient_id);
CREATE INDEX notifications_request_id_idx ON public.notifications USING btree (request_id);
CREATE UNIQUE INDEX profiles_email_lower_uniq ON public.profiles USING btree (lower(email)) WHERE (email IS NOT NULL);
CREATE UNIQUE INDEX profiles_phone_uniq ON public.profiles USING btree (phone) WHERE (phone IS NOT NULL);
CREATE UNIQUE INDEX universities_name_country_key ON public.universities USING btree (name, country);
