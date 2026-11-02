-- ============================================================================
-- 行级安全（RLS）策略 + 触发器
-- 与生产库 pg_policies / pg_trigger 逐条对应（基线时间 2026-10-26）
-- 前提：auth.uid() 由平台注入；is_admin() 函数见 90-functions-live.sql
-- ============================================================================

-- ---------- 启用 RLS ----------
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_enqueue_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.institution_journal_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_review_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.point_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.point_legacy_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.point_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.universities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.violations ENABLE ROW LEVEL SECURITY;
-- 以下 4 张表在基线版本中为 RLS 关闭（靠 REVOKE 控制访问）：
--   app_secret / email_verify_codes / identity_links / link_send_log

-- ---------- 策略 ----------
CREATE POLICY admins_read ON public.admins FOR SELECT TO authenticated USING (true);

CREATE POLICY af_insert ON public.attachment_files FOR INSERT TO authenticated
WITH CHECK ((EXISTS ( SELECT 1
   FROM attachments a
  WHERE ((a.id = attachment_files.attachment_id) AND (a.owner_id = auth.uid())))));
CREATE POLICY af_read ON public.attachment_files FOR SELECT TO authenticated
USING (((EXISTS ( SELECT 1
   FROM (attachments a
     JOIN help_requests hr ON ((hr.id = a.request_id)))
  WHERE ((a.id = attachment_files.attachment_id) AND (a.status = 'approved'::text) AND ((hr.file_expires_at IS NULL) OR (hr.file_expires_at > now()))))) OR (EXISTS ( SELECT 1
   FROM (attachments a
     JOIN help_requests hr ON ((hr.id = a.request_id)))
  WHERE ((a.id = attachment_files.attachment_id) AND (a.status = ANY (ARRAY['pending'::text, 'rejected_by_requester'::text])) AND ((hr.owner_id = auth.uid()) OR is_admin())))) OR is_admin()));

CREATE POLICY att_delete_admin ON public.attachments FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY att_delete_own ON public.attachments FOR DELETE TO authenticated USING ((owner_id = auth.uid()));
CREATE POLICY att_insert_own ON public.attachments FOR INSERT TO authenticated
WITH CHECK (((owner_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM help_requests hr
  WHERE ((hr.id = attachments.request_id) AND (hr.status = ANY (ARRAY['open'::text, 'in_progress'::text])) AND (hr.owner_id IS DISTINCT FROM auth.uid()))))));
CREATE POLICY att_read ON public.attachments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY att_update_admin ON public.attachments FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY att_update_request_owner ON public.attachments FOR UPDATE TO authenticated
USING ((EXISTS ( SELECT 1
   FROM help_requests hr
  WHERE ((hr.id = attachments.request_id) AND (hr.owner_id = auth.uid())))))
WITH CHECK ((EXISTS ( SELECT 1
   FROM help_requests hr
  WHERE ((hr.id = attachments.request_id) AND (hr.owner_id = auth.uid())))));

CREATE POLICY b_admin ON public.bans FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY b_own ON public.bans FOR SELECT TO authenticated USING ((user_id = auth.uid()));

CREATE POLICY eo_read ON public.email_outbox FOR SELECT TO authenticated USING (((recipient_id = auth.uid()) OR is_admin()));
CREATE POLICY eo_update ON public.email_outbox FOR UPDATE TO authenticated USING ((recipient_id = auth.uid())) WITH CHECK ((recipient_id = auth.uid()));

CREATE POLICY hr_delete_admin ON public.help_requests FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY hr_delete_own ON public.help_requests FOR DELETE TO authenticated USING ((owner_id = auth.uid()));
CREATE POLICY hr_insert_own ON public.help_requests FOR INSERT TO authenticated WITH CHECK ((owner_id = auth.uid()));
CREATE POLICY hr_read ON public.help_requests FOR SELECT TO anon, authenticated
USING (((owner_id = auth.uid()) OR is_admin() OR (EXISTS ( SELECT 1
   FROM attachments a
  WHERE ((a.request_id = help_requests.id) AND (a.owner_id = auth.uid())))) OR ((status = ANY (ARRAY['open'::text, 'seeking'::text])) AND (NOT (EXISTS ( SELECT 1
   FROM attachments a2
  WHERE ((a2.request_id = help_requests.id) AND (a2.status = ANY (ARRAY['pending'::text, 'rejected_by_requester'::text]))))))) OR ((status = 'completed'::text) AND (COALESCE(file_expires_at, (completed_at + '48:00:00'::interval)) > now()))));
CREATE POLICY hr_update_admin ON public.help_requests FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY hr_update_own ON public.help_requests FOR UPDATE TO authenticated USING ((owner_id = auth.uid())) WITH CHECK ((owner_id = auth.uid()));

CREATE POLICY nt_insert ON public.notifications FOR INSERT TO authenticated WITH CHECK ((sender_id = auth.uid()));
CREATE POLICY nt_read ON public.notifications FOR SELECT TO authenticated USING ((recipient_id = auth.uid()));
CREATE POLICY nt_update_recipient ON public.notifications FOR UPDATE TO authenticated USING ((recipient_id = auth.uid())) WITH CHECK ((recipient_id = auth.uid()));

CREATE POLICY papers_admin_delete ON public.papers FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY papers_admin_update ON public.papers FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY papers_insert ON public.papers FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY papers_read ON public.papers FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY pt_acc_read_own ON public.point_accounts FOR SELECT TO anon, authenticated USING (((user_id = auth.uid()) OR is_admin()));
CREATE POLICY pt_tx_read_own ON public.point_transactions FOR SELECT TO anon, authenticated USING (((user_id = auth.uid()) OR is_admin()));

CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_admin()));
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

CREATE POLICY rl_insert ON public.review_logs FOR INSERT TO authenticated
WITH CHECK (((reviewer_id = auth.uid()) AND (is_admin() OR (EXISTS ( SELECT 1
   FROM (attachments a
     JOIN help_requests hr ON ((hr.id = a.request_id)))
  WHERE ((a.id = review_logs.attachment_id) AND (hr.owner_id = auth.uid())))))));
CREATE POLICY rl_read ON public.review_logs FOR SELECT TO authenticated USING (true);

CREATE POLICY rt_admin ON public.review_tasks FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY rt_requester_read ON public.review_tasks FOR SELECT TO authenticated
USING ((EXISTS ( SELECT 1
   FROM help_requests hr
  WHERE ((hr.id = review_tasks.request_id) AND (hr.owner_id = auth.uid())))));

CREATE POLICY sub_delete ON public.subscriptions FOR DELETE TO authenticated USING (((owner_id = auth.uid()) OR is_admin()));
CREATE POLICY sub_insert_own ON public.subscriptions FOR INSERT TO authenticated WITH CHECK ((owner_id = auth.uid()));
CREATE POLICY sub_read ON public.subscriptions FOR SELECT TO authenticated USING (((owner_id = auth.uid()) OR is_admin()));

CREATE POLICY uni_delete_admin ON public.universities FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY uni_read ON public.universities FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY uni_update_admin ON public.universities FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY uni_write_admin ON public.universities FOR INSERT TO authenticated WITH CHECK (is_admin());

CREATE POLICY v_admin ON public.violations FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY v_own ON public.violations FOR SELECT TO authenticated USING ((user_id = auth.uid()));

-- ---------- 触发器 ----------
-- 悬赏守恒守卫：阻止绕过服务端函数直接改动悬赏金额或状态
CREATE CONSTRAINT TRIGGER help_request_bounty_guard_ins
  AFTER INSERT ON public.help_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_help_request_bounty_guard();

CREATE CONSTRAINT TRIGGER help_request_bounty_guard_upd
  AFTER UPDATE OF bounty_points, bounty_status ON public.help_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_help_request_bounty_guard();
