-- 科研互助平台 数据库函数（基线版本，2026-10-26）
-- 来源：生产库 pg_get_functiondef()，逐字符导出
-- 说明：包含 SECURITY DEFINER / SET search_path，恢复顺序先表结构后本文件

CREATE OR REPLACE FUNCTION public.admin_journal_logs(p_limit integer DEFAULT 100)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rows json;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) INTO rows
  FROM (
    SELECT l.id, l.submission_id, l.subscription_id, l.journal_id, l.university_id,
           l.action, l.note, l.reviewer_name, l.reviewer_id, l.created_at,
           coalesce(s.journal_title, j.title) AS journal_title,
           u.name AS university_name
    FROM journal_review_logs l
    LEFT JOIN journal_submissions s ON s.id = l.submission_id
    LEFT JOIN journals j ON j.id = l.journal_id
    LEFT JOIN universities u ON u.id = l.university_id
    ORDER BY l.created_at DESC
    LIMIT GREATEST(LEAST(coalesce(p_limit,100), 500), 1)
  ) t;
  RETURN json_build_object('ok', true, 'rows', rows);
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_list_journal_submissions(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rows json;
  st text := nullif(btrim(coalesce(p_status,'')), '');
  summary json;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) INTO rows
  FROM (
    SELECT s.*, pr.nickname AS submitter_nick,
           (SELECT count(*)::int FROM journal_review_logs l WHERE l.submission_id = s.id) AS log_count
    FROM journal_submissions s
    LEFT JOIN profiles pr ON pr.user_id = s.submitter_id
    WHERE (st IS NULL OR s.status = st)
    ORDER BY s.created_at DESC
    LIMIT GREATEST(LEAST(coalesce(p_limit, 200), 500), 1)
  ) t;
  SELECT json_object_agg(x.status, x.n) INTO summary
  FROM (SELECT status, count(*)::int AS n FROM journal_submissions GROUP BY status) x;
  RETURN json_build_object('ok', true, 'rows', rows, 'summary', COALESCE(summary, '{}'::json));
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_list_journals(p_kw text DEFAULT NULL::text, p_limit integer DEFAULT 300)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rows json;
  kw text := nullif(btrim(coalesce(p_kw,'')), '');
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  SELECT COALESCE(json_agg(t ORDER BY t.title), '[]'::json) INTO rows
  FROM (
    SELECT j.id, j.title, j.issn, j.eissn, j.publisher, j.subject, j.official_url, j.created_at,
           (SELECT count(*)::int FROM institution_journal_subscriptions s WHERE s.journal_id = j.id) AS sub_count,
           (SELECT count(*)::int FROM institution_journal_subscriptions s WHERE s.journal_id = j.id AND s.status='verified') AS verified_count
    FROM journals j
    WHERE (kw IS NULL OR j.title ILIKE '%'||kw||'%' OR coalesce(j.issn,'') ILIKE '%'||kw||'%'
           OR coalesce(j.eissn,'') ILIKE '%'||kw||'%' OR coalesce(j.publisher,'') ILIKE '%'||kw||'%')
    ORDER BY j.title
    LIMIT GREATEST(LEAST(coalesce(p_limit,300), 1000), 1)
  ) t;
  RETURN json_build_object('ok', true, 'rows', rows);
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_list_subscriptions(p_university_id bigint DEFAULT NULL::bigint, p_kw text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 500)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rows json;
  kw text := nullif(btrim(coalesce(p_kw,'')), '');
  st text := nullif(btrim(coalesce(p_status,'')), '');
  stats json;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  SELECT COALESCE(json_agg(t ORDER BY t.university_id, t.title), '[]'::json) INTO rows
  FROM (
    SELECT s.id, s.university_id, u.name AS university_name, s.journal_id, j.title, j.issn, j.eissn,
           j.publisher, j.subject, s.status, s.database_name, s.coverage_scope, s.coverage_years,
           s.source_type, s.source_url, s.evidence_note, s.reviewer_name, s.reviewed_at,
           s.is_demo, s.is_active, s.submission_id, s.created_at, s.updated_at
    FROM institution_journal_subscriptions s
    JOIN journals j ON j.id = s.journal_id
    JOIN universities u ON u.id = s.university_id
    WHERE (p_university_id IS NULL OR s.university_id = p_university_id)
      AND (st IS NULL OR s.status = st)
      AND (kw IS NULL OR j.title ILIKE '%'||kw||'%' OR coalesce(j.issn,'') ILIKE '%'||kw||'%'
           OR coalesce(j.publisher,'') ILIKE '%'||kw||'%' OR u.name ILIKE '%'||kw||'%')
    ORDER BY s.university_id, j.title
    LIMIT GREATEST(LEAST(coalesce(p_limit,500), 1000), 1)
  ) t;
  SELECT json_build_object(
    'verified', count(*) FILTER (WHERE s.status='verified'),
    'database_only', count(*) FILTER (WHERE s.status='database_only'),
    'pending', count(*) FILTER (WHERE s.status='pending'),
    'revoked', count(*) FILTER (WHERE s.status='revoked'),
    'demo', count(*) FILTER (WHERE s.is_demo)) INTO stats
  FROM institution_journal_subscriptions s;
  RETURN json_build_object('ok', true, 'rows', rows, 'stats', stats);
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_merge_journals(p_from_journal_id bigint, p_to_journal_id bigint, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  me text;
  src record;
  dst record;
  moved int := 0;
  merged_away int := 0;
  r record;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  IF p_from_journal_id = p_to_journal_id THEN RAISE EXCEPTION '不能合并到自身'; END IF;
  SELECT * INTO src FROM journals WHERE id = p_from_journal_id;
  SELECT * INTO dst FROM journals WHERE id = p_to_journal_id;
  IF src.id IS NULL OR dst.id IS NULL THEN RAISE EXCEPTION '期刊记录不存在'; END IF;
  SELECT p.nickname INTO me FROM profiles p WHERE p.user_id = uid;

  FOR r IN SELECT * FROM institution_journal_subscriptions WHERE journal_id = p_from_journal_id LOOP
    IF EXISTS (SELECT 1 FROM institution_journal_subscriptions x
               WHERE x.university_id = r.university_id AND x.journal_id = p_to_journal_id) THEN
      DELETE FROM institution_journal_subscriptions WHERE id = r.id;
      merged_away := merged_away + 1;
    ELSE
      UPDATE institution_journal_subscriptions SET journal_id = p_to_journal_id, updated_at = now() WHERE id = r.id;
      moved := moved + 1;
    END IF;
  END LOOP;

  UPDATE journal_submissions SET journal_id = p_to_journal_id, updated_at = now() WHERE journal_id = p_from_journal_id;
  UPDATE journal_review_logs SET journal_id = p_to_journal_id WHERE journal_id = p_from_journal_id;

  UPDATE journals SET
    issn = coalesce(issn, src.issn), eissn = coalesce(eissn, src.eissn),
    publisher = coalesce(publisher, src.publisher), subject = coalesce(subject, src.subject),
    official_url = coalesce(official_url, src.official_url),
    aliases = nullif(btrim(concat_ws(', ', nullif(aliases,''), nullif(src.title,''))), ''),
    updated_at = now()
  WHERE id = p_to_journal_id;

  DELETE FROM journals WHERE id = p_from_journal_id;

  INSERT INTO journal_review_logs (journal_id, action, note, reviewer_id, reviewer_name)
  VALUES (p_to_journal_id, 'merge',
    '将重复期刊「'||src.title||'」(#'||p_from_journal_id||') 合并到「'||dst.title||'」(#'||p_to_journal_id||')；转移订阅 '||moved||' 条，去重删除 '||merged_away||' 条。'||coalesce('备注：'||p_note,''),
    uid, me);

  RETURN json_build_object('ok', true, 'target_journal_id', p_to_journal_id, 'moved', moved, 'merged_away', merged_away);
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_review_attachment(att_id bigint, resolution text, note text, reviewer_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; att attachments%ROWTYPE; req help_requests%ROWTYPE; pay json; paid boolean := false; refund json; refunded boolean := false; pay_points integer := 0; vcount integer := 0; vid bigint; task_id bigint; last_reward timestamptz; exp_at timestamptz; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录'; END IF; IF NOT is_admin() THEN RAISE EXCEPTION '只有管理员可以执行最终复核'; END IF; IF resolution NOT IN ('conform','nonconform') THEN RAISE EXCEPTION '无效的复核结论：%', resolution; END IF; IF NULLIF(btrim(note),'') IS NULL THEN RAISE EXCEPTION '管理员必须填写最终审核意见'; END IF; SELECT * INTO att FROM attachments WHERE id = att_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '附件不存在'; END IF; SELECT * INTO req FROM help_requests WHERE id = att.request_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '关联求助不存在'; END IF; IF req.status <> 'pending_admin_review' THEN RAISE EXCEPTION '该求助当前不在待管理员复核状态（当前：%）', req.status; END IF; IF att.status <> 'rejected_by_requester' THEN RAISE EXCEPTION '该附件当前不是待复核状态（当前：%）', att.status; END IF; SELECT id INTO task_id FROM review_tasks WHERE attachment_id = att_id AND resolved_at IS NULL LIMIT 1; IF resolution = 'conform' THEN exp_at := now() + interval '48 hours'; UPDATE attachments SET status='approved', review_note=note, reviewed_by=uid, reviewed_at=now(), expires_at=exp_at WHERE id=att_id; UPDATE attachments SET status='closed', review_note='管理员复核通过，该附件未被采纳', reviewed_by=uid, reviewed_at=now(), expires_at=exp_at WHERE request_id=req.id AND status IN ('pending','rejected_by_requester') AND id<>att_id; UPDATE help_requests SET status='completed', updated_at=now(), completed_at=now(), completed_by=uid, file_expires_at=exp_at, file_cleanup_status='pending' WHERE id=req.id; pay_points := COALESCE(req.bounty_points, 0); IF req.bounty_status = 'locked' AND pay_points > 0 THEN pay := point_grant(att.owner_id, 'bounty_reward', pay_points, 'bounty_reward:' || req.id, req.id, att.id, '管理员复核通过，求助 #' || req.id || ' 悬赏 ' || pay_points || ' 积分已支付'); paid := COALESCE((pay->>'applied')::boolean, false); IF paid THEN UPDATE help_requests SET bounty_status='paid', bounty_paid_at=now(), bounty_paid_to=att.owner_id WHERE id=req.id AND bounty_status='locked'; END IF; END IF; INSERT INTO review_logs (attachment_id, action, note, reviewer_name) VALUES (att_id, 'admin_approve', note, reviewer_name); IF task_id IS NOT NULL THEN UPDATE review_tasks SET resolved_at=now(), resolved_by=uid, resolution='conform', admin_note=note WHERE id=task_id; END IF; INSERT INTO notifications (recipient_id, request_id, title, content) VALUES (att.owner_id, req.id, '管理员复核通过', '你上传的附件「' || att.file_name || '」经管理员复核符合求助要求（求助 #' || req.id || '），悬赏 ' || pay_points || ' 积分已支付。'); RETURN json_build_object('ok', true, 'resolution', 'conform', 'request_status', 'completed', 'bounty_paid', paid, 'bounty_points', CASE WHEN paid THEN pay_points ELSE 0 END); ELSE UPDATE attachments SET status='rejected_by_admin', review_note=note, reviewed_by=uid, reviewed_at=now() WHERE id=att_id; UPDATE attachments SET status='closed', review_note='求助已关闭，该附件未被采纳', reviewed_by=uid, reviewed_at=now() WHERE request_id=req.id AND status IN ('pending','rejected_by_requester') AND id<>att_id; UPDATE help_requests SET status='closed', updated_at=now() WHERE id=req.id; IF req.bounty_status = 'locked' AND COALESCE(req.bounty_points,0) > 0 THEN refund := point_grant(req.owner_id, 'bounty_refund', req.bounty_points, 'bounty_refund:' || req.id, req.id, NULL, '管理员判定文件不符合要求，退还求助 #' || req.id || ' 预留悬赏 ' || req.bounty_points || ' 积分'); refunded := COALESCE((refund->>'applied')::boolean, false); IF refunded THEN UPDATE help_requests SET bounty_status='refunded', bounty_refunded_at=now() WHERE id=req.id; END IF; END IF; INSERT INTO violations (user_id, attachment_id, request_id, reason, dedupe_key) VALUES (att.owner_id, att.id, req.id, note, 'violation:' || att.id) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id INTO vid; IF vid IS NOT NULL THEN SELECT max(created_at) INTO last_reward FROM point_transactions WHERE user_id = att.owner_id AND type = 'bounty_reward'; SELECT count(*) INTO vcount FROM violations v WHERE v.user_id = att.owner_id AND v.created_at > COALESCE(last_reward, '1970-01-01'::timestamptz); IF vcount >= 3 THEN INSERT INTO bans (user_id, starts_at, ends_at, reason) VALUES (att.owner_id, now(), now() + interval '3 days', '连续 ' || vcount || ' 次上传文件经管理员判定不符合要求，封禁 3 天'); UPDATE help_requests SET status='invalid', invalid_reason='应助人 ' || att.owner_id || ' 连续违规触发封禁，该求助关联判定无效' WHERE id = req.id; INSERT INTO notifications (recipient_id, request_id, title, content) VALUES (att.owner_id, req.id, '你已被封禁 3 天', '你上传的附件「' || att.file_name || '」经管理员复核不符合要求（求助 #' || req.id || '），已累计 ' || vcount || ' 次违规，账号封禁至 ' || to_char(now() + interval '3 days', 'YYYY-MM-DD HH24:MI') || '。封禁期间不能上传应助文件。'); END IF; END IF; INSERT INTO review_logs (attachment_id, action, note, reviewer_name) VALUES (att_id, 'admin_reject', note, reviewer_name); IF task_id IS NOT NULL THEN UPDATE review_tasks SET resolved_at=now(), resolved_by=uid, resolution='nonconform', admin_note=note WHERE id=task_id; END IF; INSERT INTO notifications (recipient_id, request_id, title, content) VALUES (att.owner_id, req.id, '管理员复核未通过', '你上传的附件「' || att.file_name || '」经管理员复核不符合求助要求（求助 #' || req.id || '）。请在上传前仔细核对论文标题、DOI、期刊、年份及求助说明，避免提交错误或无关文件。'); RETURN json_build_object('ok', true, 'resolution', 'nonconform', 'request_status', 'closed', 'refunded', refunded, 'refund_points', CASE WHEN refunded THEN req.bounty_points ELSE 0 END, 'violation_count', vcount, 'banned', (vcount >= 3)); END IF; END; $function$
;

CREATE OR REPLACE FUNCTION public.admin_review_journal_submission(p_id bigint, p_action text, p_note text DEFAULT NULL::text, p_verify_level text DEFAULT 'journal'::text, p_coverage_years text DEFAULT NULL::text, p_coverage_scope text DEFAULT NULL::text, p_database_name text DEFAULT NULL::text, p_source_url text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  me text;
  sub record;
  jid bigint;
  sid bigint;
  lvl text := coalesce(nullif(btrim(coalesce(p_verify_level,'')), ''), 'journal');
  vstatus text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  IF p_action NOT IN ('approve','reject','need_info') THEN RAISE EXCEPTION '未知的审核动作'; END IF;
  IF lvl NOT IN ('journal','database_only') THEN RAISE EXCEPTION '核验级别只能是 journal 或 database_only'; END IF;

  SELECT p.nickname INTO me FROM profiles p WHERE p.user_id = uid;
  SELECT * INTO sub FROM journal_submissions WHERE id = p_id FOR UPDATE;
  IF sub.id IS NULL THEN RAISE EXCEPTION '提交记录不存在'; END IF;
  IF sub.status NOT IN ('pending','need_info') THEN RAISE EXCEPTION '当前状态（%）不可再审核', sub.status; END IF;

  IF p_action = 'approve' THEN
    jid := public.resolve_journal(sub.journal_title, sub.issn, sub.eissn, sub.publisher, sub.subject, sub.library_url);
    vstatus := CASE WHEN lvl = 'journal' THEN 'verified' ELSE 'database_only' END;
    INSERT INTO institution_journal_subscriptions AS s
      (university_id, journal_id, status, database_name, coverage_scope, coverage_years,
       source_type, source_url, evidence_note, reviewer_id, reviewer_name, reviewed_at, is_demo, is_active, submission_id)
    VALUES
      (sub.university_id, jid, vstatus,
       coalesce(nullif(btrim(coalesce(p_database_name,'')), ''), sub.database_name),
       coalesce(nullif(btrim(coalesce(p_coverage_scope,'')), ''), sub.coverage_scope),
       coalesce(nullif(btrim(coalesce(p_coverage_years,'')), ''), sub.coverage_years),
       'user_submission',
       coalesce(nullif(btrim(coalesce(p_source_url,'')), ''), sub.library_url),
       coalesce(nullif(btrim(coalesce(p_note,'')), ''), sub.evidence_note),
       uid, me, now(), false, true, sub.id)
    ON CONFLICT (university_id, journal_id) DO UPDATE SET
      status = EXCLUDED.status, database_name = EXCLUDED.database_name,
      coverage_scope = EXCLUDED.coverage_scope, coverage_years = EXCLUDED.coverage_years,
      source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
      evidence_note = EXCLUDED.evidence_note, reviewer_id = EXCLUDED.reviewer_id,
      reviewer_name = EXCLUDED.reviewer_name, reviewed_at = now(),
      is_active = true, submission_id = EXCLUDED.submission_id, updated_at = now()
    RETURNING s.id INTO sid;

    UPDATE journal_submissions SET status = 'approved', admin_note = p_note, reviewed_by = uid,
      reviewer_name = me, reviewed_at = now(), journal_id = jid, updated_at = now()
    WHERE id = p_id;
  ELSIF p_action = 'reject' THEN
    UPDATE journal_submissions SET status = 'rejected', admin_note = p_note, reviewed_by = uid,
      reviewer_name = me, reviewed_at = now(), updated_at = now()
    WHERE id = p_id;
  ELSE
    UPDATE journal_submissions SET status = 'need_info', admin_note = p_note, reviewed_by = uid,
      reviewer_name = me, reviewed_at = now(), updated_at = now()
    WHERE id = p_id;
  END IF;

  INSERT INTO journal_review_logs (submission_id, subscription_id, journal_id, university_id, action, note, reviewer_id, reviewer_name)
  VALUES (p_id, sid, jid, sub.university_id, p_action, p_note, uid, me);

  RETURN json_build_object('ok', true, 'id', p_id,
    'status', CASE WHEN p_action='approve' THEN 'approved' WHEN p_action='reject' THEN 'rejected' ELSE 'need_info' END,
    'subscription_id', sid, 'journal_id', jid, 'verify_level', lvl);
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_revoke_subscription(p_id bigint, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  me text;
  r record;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  SELECT p.nickname INTO me FROM profiles p WHERE p.user_id = uid;
  SELECT * INTO r FROM institution_journal_subscriptions WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION '订阅记录不存在'; END IF;
  UPDATE institution_journal_subscriptions
     SET status = 'revoked', is_active = false, reviewer_id = uid, reviewer_name = me,
         reviewed_at = now(), updated_at = now(), evidence_note = coalesce(nullif(btrim(coalesce(p_note,'')),''), evidence_note)
   WHERE id = p_id;
  INSERT INTO journal_review_logs (subscription_id, journal_id, university_id, action, note, reviewer_id, reviewer_name)
  VALUES (p_id, r.journal_id, r.university_id, 'revoke', p_note, uid, me);
  RETURN json_build_object('ok', true, 'id', p_id, 'status', 'revoked');
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_upsert_subscription(p_university_id bigint, p_journal_title text, p_journal_id bigint DEFAULT NULL::bigint, p_status text DEFAULT 'pending'::text, p_issn text DEFAULT NULL::text, p_eissn text DEFAULT NULL::text, p_publisher text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_database_name text DEFAULT NULL::text, p_coverage_years text DEFAULT NULL::text, p_coverage_scope text DEFAULT NULL::text, p_source_url text DEFAULT NULL::text, p_evidence_note text DEFAULT NULL::text, p_is_demo boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  me text;
  jid bigint;
  sid bigint;
  st text := coalesce(nullif(btrim(coalesce(p_status,'')), ''), 'pending');
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '需要管理员权限'; END IF;
  IF st NOT IN ('pending','database_only','verified','revoked') THEN RAISE EXCEPTION '未知的核验状态'; END IF;
  IF NOT EXISTS (SELECT 1 FROM universities u WHERE u.id = p_university_id) THEN RAISE EXCEPTION '院校不存在'; END IF;
  SELECT p.nickname INTO me FROM profiles p WHERE p.user_id = uid;

  jid := coalesce(p_journal_id, public.resolve_journal(p_journal_title, p_issn, p_eissn, p_publisher, p_subject, p_source_url));

  INSERT INTO institution_journal_subscriptions AS s
    (university_id, journal_id, status, database_name, coverage_scope, coverage_years,
     source_type, source_url, evidence_note, reviewer_id, reviewer_name, reviewed_at, is_demo, is_active)
  VALUES
    (p_university_id, jid, st, p_database_name, p_coverage_scope, p_coverage_years,
     'admin', p_source_url, p_evidence_note, uid, me,
     CASE WHEN st IN ('verified','database_only') THEN now() ELSE NULL END,
     coalesce(p_is_demo, false), st <> 'revoked')
  ON CONFLICT (university_id, journal_id) DO UPDATE SET
    status = EXCLUDED.status, database_name = EXCLUDED.database_name,
    coverage_scope = EXCLUDED.coverage_scope, coverage_years = EXCLUDED.coverage_years,
    source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
    evidence_note = EXCLUDED.evidence_note, reviewer_id = EXCLUDED.reviewer_id,
    reviewer_name = EXCLUDED.reviewer_name, reviewed_at = EXCLUDED.reviewed_at,
    is_demo = EXCLUDED.is_demo, is_active = EXCLUDED.is_active, updated_at = now()
  RETURNING s.id INTO sid;

  INSERT INTO journal_review_logs (subscription_id, journal_id, university_id, action, note, reviewer_id, reviewer_name)
  VALUES (sid, jid, p_university_id, 'edit_range',
          '管理员设定状态为 '||st||coalesce('；依据：'||nullif(btrim(coalesce(p_evidence_note,'')),''), ''), uid, me);

  RETURN json_build_object('ok', true, 'subscription_id', sid, 'journal_id', jid, 'status', st, 'is_demo', coalesce(p_is_demo,false));
END $function$
;

CREATE OR REPLACE FUNCTION public.bind_identity(p_secret text, p_uid text, p_kind text, p_value text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v text; v_uid bigint; cur text; other_id bigint; prof_other text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_secret WHERE id = 1 AND worker_secret = p_secret) THEN
    RAISE EXCEPTION '服务凭据无效';
  END IF;
  IF p_kind NOT IN ('email','phone') THEN RAISE EXCEPTION '绑定类型不合法'; END IF;
  v := public.norm_identity(p_kind, p_value);
  IF v IS NULL THEN RAISE EXCEPTION '手机号或邮箱格式不正确'; END IF;
  BEGIN v_uid := p_uid::bigint; EXCEPTION WHEN others THEN RAISE EXCEPTION '用户标识不合法'; END;

  IF p_kind = 'phone' THEN
    SELECT phone_number INTO cur FROM auth.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION '用户不存在'; END IF;
    IF cur IS NOT NULL AND btrim(cur) <> '' AND cur <> v THEN
      RAISE EXCEPTION '当前账号已绑定其他手机号（%），如需变更请联系管理员', cur;
    END IF;
    SELECT id INTO other_id FROM auth.users WHERE phone_number = v AND id <> v_uid LIMIT 1;
    IF other_id IS NOT NULL THEN RAISE EXCEPTION '该手机号已被其他账号占用，请用原账号登录后管理，系统不会自动合并账号'; END IF;
    SELECT user_id INTO prof_other FROM public.profiles WHERE phone = v AND user_id <> p_uid LIMIT 1;
    IF prof_other IS NOT NULL THEN RAISE EXCEPTION '该手机号已被其他账号占用，请用原账号登录后管理，系统不会自动合并账号'; END IF;
    UPDATE auth.users SET phone_number = v, updated_at = now() WHERE id = v_uid;
    INSERT INTO public.profiles (user_id) VALUES (p_uid) ON CONFLICT (user_id) DO NOTHING;
    UPDATE public.profiles SET phone = v, phone_verified = true, phone_verified_at = now(), updated_at = now() WHERE user_id = p_uid;
  ELSE
    SELECT email INTO cur FROM auth.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION '用户不存在'; END IF;
    IF cur IS NOT NULL AND btrim(cur) <> '' AND lower(btrim(cur)) <> v THEN
      RAISE EXCEPTION '当前账号已绑定其他邮箱（%），如需变更请联系管理员', cur;
    END IF;
    SELECT id INTO other_id FROM auth.users WHERE lower(btrim(email)) = v AND id <> v_uid LIMIT 1;
    IF other_id IS NOT NULL THEN RAISE EXCEPTION '该邮箱已绑定到其他账号，请用原账号登录后管理，系统不会自动合并账号'; END IF;
    SELECT user_id INTO prof_other FROM public.profiles WHERE lower(btrim(email)) = v AND user_id <> p_uid LIMIT 1;
    IF prof_other IS NOT NULL THEN RAISE EXCEPTION '该邮箱已绑定到其他账号，请用原账号登录后管理，系统不会自动合并账号'; END IF;
    UPDATE auth.users SET email = v, email_verified = true, updated_at = now() WHERE id = v_uid;
    INSERT INTO public.profiles (user_id) VALUES (p_uid) ON CONFLICT (user_id) DO NOTHING;
    UPDATE public.profiles SET email = v, email_verified = true, email_verified_at = now(), updated_at = now() WHERE user_id = p_uid;
  END IF;

  INSERT INTO public.identity_links (user_id, kind, value, action) VALUES (p_uid, p_kind, v, 'bind');
  RETURN public.login_state_for(p_uid);
END; $function$
;

CREATE OR REPLACE FUNCTION public.claim_emails(p_secret text, p_limit integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE ok boolean; ids bigint[]; BEGIN SELECT (worker_secret = btrim(COALESCE(p_secret, ''))) INTO ok FROM app_secret WHERE id = 1; IF NOT COALESCE(ok, false) THEN RAISE EXCEPTION '无效的投递凭据'; END IF; SELECT array_agg(id) INTO ids FROM (SELECT id FROM email_outbox WHERE status IN ('pending', 'failed') AND attempts < 3 AND created_at > now() - interval '3 days' ORDER BY created_at ASC LIMIT GREATEST(COALESCE(p_limit, 10), 1) FOR UPDATE SKIP LOCKED) s; IF ids IS NULL THEN RETURN '[]'::json; END IF; UPDATE email_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ANY(ids); RETURN (SELECT COALESCE(json_agg(t ORDER BY t.id), '[]'::json) FROM (SELECT id, recipient_email, subject, body, kind, attempts FROM email_outbox WHERE id = ANY(ids)) t); END; $function$
;

CREATE OR REPLACE FUNCTION public.claim_link_send(p_secret text, p_kind text, p_value text, p_uid text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v text; last_at timestamptz; cnt int; earliest timestamptz; wait_s int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_secret WHERE id = 1 AND worker_secret = p_secret) THEN
    RAISE EXCEPTION '服务凭据无效';
  END IF;
  IF p_kind NOT IN ('email','phone') THEN RAISE EXCEPTION '绑定类型不合法'; END IF;
  v := public.norm_identity(p_kind, p_value);
  IF v IS NULL THEN RAISE EXCEPTION '手机号或邮箱格式不正确'; END IF;
  SELECT max(created_at) INTO last_at FROM public.link_send_log WHERE kind = p_kind AND value = v;
  IF last_at IS NOT NULL AND now() - last_at < interval '60 seconds' THEN
    wait_s := CEIL(EXTRACT(EPOCH FROM (interval '60 seconds' - (now() - last_at))))::int;
    RETURN json_build_object('ok', false, 'reason', 'cooldown', 'retry_after', GREATEST(wait_s, 1));
  END IF;
  SELECT count(*), min(created_at) INTO cnt, earliest FROM public.link_send_log
   WHERE kind = p_kind AND value = v AND created_at > now() - interval '10 minutes';
  IF cnt >= 5 THEN
    wait_s := CEIL(EXTRACT(EPOCH FROM (earliest + interval '10 minutes' - now())))::int;
    RETURN json_build_object('ok', false, 'reason', 'rate_limited', 'retry_after', GREATEST(wait_s, 1));
  END IF;
  INSERT INTO public.link_send_log (kind, value, user_id) VALUES (p_kind, v, p_uid);
  RETURN json_build_object('ok', true, 'value', v, 'sent_last_10min', cnt + 1);
END; $function$
;

CREATE OR REPLACE FUNCTION public.cleanup_expired_files()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE r record; cnt integer := 0; expired_ids bigint[] := '{}'; BEGIN FOR r IN SELECT a.id, a.file_path FROM attachments a JOIN help_requests hr ON hr.id = a.request_id WHERE hr.status = 'completed' AND hr.file_expires_at IS NOT NULL AND hr.file_expires_at <= now() AND (hr.file_cleanup_status IS DISTINCT FROM 'done') AND a.status IN ('approved','closed','rejected_by_requester','rejected_by_admin') LOOP UPDATE attachments SET status = 'expired' WHERE id = r.id AND status <> 'expired'; expired_ids := expired_ids || r.id; cnt := cnt + 1; END LOOP; IF cnt > 0 THEN UPDATE help_requests hr SET file_cleanup_status = 'done', file_deleted_at = now() WHERE hr.status = 'completed' AND hr.file_expires_at IS NOT NULL AND hr.file_expires_at <= now() AND hr.file_cleanup_status IS DISTINCT FROM 'done'; END IF; RETURN json_build_object('ok', true, 'expired_count', cnt, 'attachment_ids', expired_ids); END; $function$
;

CREATE OR REPLACE FUNCTION public.confirm_email_bind(p_email text, p_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; norm text; rec email_verify_codes%ROWTYPE; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF; norm := lower(btrim(COALESCE(p_email, ''))); IF norm = '' THEN RAISE EXCEPTION '请填写邮箱'; END IF; IF btrim(COALESCE(p_code, '')) !~ '^[0-9]{6}$' THEN RAISE EXCEPTION '验证码应为 6 位数字'; END IF; SELECT * INTO rec FROM email_verify_codes WHERE user_id = uid AND email = norm AND purpose = 'bind_email' AND consumed_at IS NULL ORDER BY id DESC LIMIT 1; IF NOT FOUND THEN RAISE EXCEPTION '请先获取邮箱验证码'; END IF; IF rec.expires_at <= now() THEN RAISE EXCEPTION '验证码已过期，请重新获取'; END IF; IF rec.attempts >= 5 THEN RAISE EXCEPTION '验证码错误次数过多，请重新获取'; END IF; IF rec.code_hash <> md5(btrim(p_code) || rec.salt) THEN UPDATE email_verify_codes SET attempts = attempts + 1 WHERE id = rec.id; RAISE EXCEPTION '验证码不正确'; END IF; UPDATE email_verify_codes SET consumed_at = now() WHERE id = rec.id; BEGIN UPDATE profiles SET email = norm, email_verified = true, email_verified_at = now(), updated_at = now() WHERE user_id = uid; EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '该邮箱已绑定到其他账号，不能重复绑定'; END; INSERT INTO notifications (recipient_id, title, content) VALUES (uid, '邮箱绑定成功', '你的账号已绑定并验证邮箱 ' || norm || '，今后可接收求助审核提醒邮件。'); RETURN json_build_object('ok', true, 'email', norm, 'email_verified', true); END; $function$
;
CREATE OR REPLACE FUNCTION public.create_request_with_bounty(p_paper_id bigint, p_doi text, p_paper_title text, p_authors text, p_journal text, p_journal_type text, p_published_year integer, p_volume text, p_issue text, p_pages text, p_publisher text, p_source_url text, p_description text, p_owner_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; BOUNTY constant integer := 5; bal integer; rid bigint; res json; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录后再发布求助'; END IF; INSERT INTO point_accounts (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING; SELECT balance INTO bal FROM point_accounts WHERE user_id = uid FOR UPDATE; IF bal IS NULL OR bal < BOUNTY THEN RAISE EXCEPTION '可用积分不足：发布求助需预留 % 积分，当前可用 % 积分。请先到个人中心每日签到获取积分后再发布。', BOUNTY, COALESCE(bal, 0); END IF; INSERT INTO help_requests (owner_id, owner_name, paper_id, doi, paper_title, authors, journal, journal_type, published_year, volume, issue, pages, publisher, source_url, description, status, bounty_points, bounty_status, bounty_locked_at) VALUES (uid, p_owner_name, p_paper_id, p_doi, p_paper_title, p_authors, p_journal, p_journal_type, p_published_year, p_volume, p_issue, p_pages, p_publisher, p_source_url, p_description, 'open', BOUNTY, 'locked', now()) RETURNING id INTO rid; IF rid IS NULL THEN RAISE EXCEPTION '求助记录创建失败，积分预留已回滚'; END IF; res := point_grant(uid, 'bounty_lock', -BOUNTY, 'bounty_lock:' || rid, rid, NULL, '发布求助 #' || rid || ' 预留悬赏 ' || BOUNTY || ' 积分'); IF NOT COALESCE((res->>'applied')::boolean, false) THEN RAISE EXCEPTION '悬赏预留记账失败，求助创建已回滚'; END IF; RETURN json_build_object('ok', true, 'id', rid, 'bounty_points', BOUNTY, 'bounty_status', 'locked', 'balance', bal - BOUNTY); END; $function$
;

CREATE OR REPLACE FUNCTION public.daily_checkin()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; d date; res json; bal integer; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录后再签到'; END IF; d := (now() AT TIME ZONE 'Asia/Shanghai')::date; res := point_grant(uid, 'daily_checkin', 5, 'checkin:' || uid || ':' || to_char(d, 'YYYY-MM-DD'), NULL, NULL, '每日签到奖励 5 积分（' || to_char(d, 'YYYY-MM-DD') || '）'); SELECT balance INTO bal FROM point_accounts WHERE user_id = uid; RETURN json_build_object('date', d, 'applied', COALESCE((res->>'applied')::boolean, false), 'points', 5, 'balance', bal, 'already', NOT COALESCE((res->>'applied')::boolean, false)); END; $function$
;

CREATE OR REPLACE FUNCTION public.daily_helper_leaderboard(p_limit integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE d date; ts_start timestamptz; ts_end timestamptz; uid text; top json; me json; total_helpers integer; lim integer; BEGIN d := (now() AT TIME ZONE 'Asia/Shanghai')::date; ts_start := (d::timestamp) AT TIME ZONE 'Asia/Shanghai'; ts_end := ts_start + interval '1 day'; uid := auth.uid(); lim := GREATEST(1, LEAST(COALESCE(p_limit, 10), 100)); WITH agg AS ( SELECT t.user_id, SUM(t.amount)::int AS points, COUNT(*)::int AS cnt FROM point_transactions t JOIN help_requests hr ON hr.id = t.request_id WHERE t.type = 'bounty_reward' AND t.created_at >= ts_start AND t.created_at < ts_end AND hr.owner_id IS DISTINCT FROM t.user_id GROUP BY t.user_id ), ranked AS ( SELECT row_number() OVER (ORDER BY a.points DESC, a.cnt DESC, a.user_id ASC) AS rank, a.user_id, a.points, a.cnt, COALESCE(NULLIF(btrim(pf.nickname), ''), '未设置昵称的用户') AS display_name FROM agg a LEFT JOIN profiles pf ON pf.user_id = a.user_id ) SELECT COALESCE(json_agg(json_build_object('rank', r.rank, 'display_name', r.display_name, 'points', r.points, 'helps', r.cnt)), '[]'::json) INTO top FROM (SELECT * FROM ranked ORDER BY rank LIMIT lim) r; WITH agg AS ( SELECT t.user_id, SUM(t.amount)::int AS points, COUNT(*)::int AS cnt FROM point_transactions t JOIN help_requests hr ON hr.id = t.request_id WHERE t.type = 'bounty_reward' AND t.created_at >= ts_start AND t.created_at < ts_end AND hr.owner_id IS DISTINCT FROM t.user_id GROUP BY t.user_id ) SELECT COUNT(*)::int INTO total_helpers FROM agg; me := NULL; IF uid IS NOT NULL AND btrim(uid) <> '' THEN WITH agg AS ( SELECT t.user_id, SUM(t.amount)::int AS points, COUNT(*)::int AS cnt FROM point_transactions t JOIN help_requests hr ON hr.id = t.request_id WHERE t.type = 'bounty_reward' AND t.created_at >= ts_start AND t.created_at < ts_end AND hr.owner_id IS DISTINCT FROM t.user_id GROUP BY t.user_id ), ranked AS ( SELECT row_number() OVER (ORDER BY a.points DESC, a.cnt DESC, a.user_id ASC) AS rank, a.user_id, a.points, a.cnt, COALESCE(NULLIF(btrim(pf.nickname), ''), '未设置昵称的用户') AS display_name FROM agg a LEFT JOIN profiles pf ON pf.user_id = a.user_id ) SELECT json_build_object('rank', r.rank, 'display_name', r.display_name, 'points', r.points, 'helps', r.cnt) INTO me FROM ranked r WHERE r.user_id = uid; END IF; RETURN json_build_object('date', d, 'top', top, 'me', me, 'total_helpers', total_helpers, 'limit', lim); END; $function$
;

CREATE OR REPLACE FUNCTION public.delete_my_request_with_refund(p_request_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; req help_requests%ROWTYPE; res json; refunded boolean := false; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录'; END IF; SELECT * INTO req FROM help_requests WHERE id = p_request_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '求助不存在或已被删除'; END IF; IF req.owner_id IS DISTINCT FROM uid AND NOT is_admin() THEN RAISE EXCEPTION '只能删除自己发布的求助'; END IF; IF req.status = 'completed' THEN RAISE EXCEPTION '已完成的求助不能删除'; END IF; IF req.status IN ('pending_requester_review','pending_admin_review') THEN RAISE EXCEPTION '该求助已有应助文件正在审核/复核中，不能删除或退还悬赏'; END IF; IF req.bounty_status = 'locked' AND COALESCE(req.bounty_points, 0) > 0 THEN res := point_grant(req.owner_id, 'bounty_refund', req.bounty_points, 'bounty_refund:' || req.id, req.id, NULL, '删除求助 #' || req.id || '，退还预留悬赏 ' || req.bounty_points || ' 积分'); refunded := COALESCE((res->>'applied')::boolean, false); END IF; DELETE FROM help_requests WHERE id = p_request_id; RETURN json_build_object('ok', true, 'id', req.id, 'deleted', true, 'refunded', refunded, 'refund_points', CASE WHEN refunded THEN req.bounty_points ELSE 0 END); END; $function$
;

CREATE OR REPLACE FUNCTION public.email_outbox_recent(p_secret text, p_limit integer DEFAULT 20)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ok boolean;
  rows json;
  stats json;
BEGIN
  SELECT (worker_secret = btrim(COALESCE(p_secret, ''))) INTO ok FROM app_secret WHERE id = 1;
  IF NOT COALESCE(ok, false) THEN RAISE EXCEPTION '无效的投递凭据'; END IF;

  SELECT COALESCE(json_agg(t ORDER BY t.id DESC), '[]'::json) INTO rows
  FROM (
    SELECT id, recipient_id, recipient_email, request_id, attachment_id, kind, status, attempts,
           last_error, dedupe_key, created_at, sent_at
    FROM email_outbox
    ORDER BY id DESC
    LIMIT GREATEST(LEAST(COALESCE(p_limit, 20), 200), 1)
  ) t;

  SELECT json_build_object(
    'pending', count(*) FILTER (WHERE status = 'pending'),
    'sending', count(*) FILTER (WHERE status = 'sending'),
    'sent', count(*) FILTER (WHERE status = 'sent'),
    'failed', count(*) FILTER (WHERE status = 'failed'),
    'expired', count(*) FILTER (WHERE status = 'expired'),
    'total', count(*)) INTO stats
  FROM email_outbox;

  RETURN json_build_object('ok', true, 'stats', stats, 'rows', rows);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_email(p_recipient_id text, p_recipient_email text, p_request_id bigint, p_attachment_id bigint, p_kind text, p_subject text, p_body text, p_dedupe_key text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE new_id bigint; BEGIN INSERT INTO email_outbox (recipient_id, recipient_email, request_id, attachment_id, kind, subject, body, dedupe_key) VALUES (p_recipient_id, p_recipient_email, p_request_id, p_attachment_id, p_kind, p_subject, p_body, p_dedupe_key) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id INTO new_id; RETURN new_id; END; $function$
;

CREATE OR REPLACE FUNCTION public.ensure_email_bind_notice()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; bound boolean; exists_n boolean; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF; SELECT COALESCE(email_verified, false) INTO bound FROM profiles WHERE user_id = uid; IF COALESCE(bound, false) THEN RETURN json_build_object('ok', true, 'needed', false); END IF; SELECT EXISTS (SELECT 1 FROM notifications WHERE recipient_id = uid AND title = '请绑定邮箱' AND is_read = false) INTO exists_n; IF NOT exists_n THEN INSERT INTO notifications (recipient_id, title, content) VALUES (uid, '请绑定邮箱', '为了方便账号恢复、密码重置以及接收求助审核提醒，建议为当前账号绑定并验证邮箱。绑定邮箱不会改变你的用户 ID、积分或历史求助记录。前往「个人中心 - 账号与安全 - 邮箱绑定」即可完成。'); END IF; RETURN json_build_object('ok', true, 'needed', true); END; $function$
;

CREATE OR REPLACE FUNCTION public.ensure_my_points()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; bal integer; res json; granted boolean := false; gtype text := NULL; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录后再使用积分功能'; END IF; INSERT INTO point_accounts (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING; IF NOT EXISTS (SELECT 1 FROM point_transactions WHERE user_id = uid AND type IN ('signup_bonus','legacy_initial_grant')) THEN IF NOT EXISTS (SELECT 1 FROM point_legacy_users WHERE user_id = uid) THEN res := point_grant(uid, 'signup_bonus', 50, 'signup:' || uid, NULL, NULL, '新用户注册赠送 50 积分'); granted := COALESCE((res->>'applied')::boolean, false); gtype := 'signup_bonus'; END IF; END IF; SELECT balance INTO bal FROM point_accounts WHERE user_id = uid; RETURN json_build_object('user_id', uid, 'balance', bal, 'granted', granted, 'grant_type', gtype, 'granted_points', CASE WHEN granted THEN 50 ELSE 0 END); END; $function$
;

CREATE OR REPLACE FUNCTION public.finish_email(p_secret text, p_id bigint, p_ok boolean, p_error text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE ok boolean; BEGIN SELECT (worker_secret = btrim(COALESCE(p_secret, ''))) INTO ok FROM app_secret WHERE id = 1; IF NOT COALESCE(ok, false) THEN RAISE EXCEPTION '无效的投递凭据'; END IF; IF p_ok THEN UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = p_id; ELSE UPDATE email_outbox SET status = 'failed', last_error = left(COALESCE(p_error, '未知错误'), 500) WHERE id = p_id; END IF; RETURN json_build_object('ok', true, 'id', p_id, 'status', CASE WHEN p_ok THEN 'sent' ELSE 'failed' END); END; $function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$ SELECT EXISTS (SELECT 1 FROM admins a WHERE a.user_id = auth.uid()) $function$
;

CREATE OR REPLACE FUNCTION public.link_precheck(p_secret text, p_uid text, p_kind text, p_value text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v text; v_uid bigint; mine boolean := false; taken boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_secret WHERE id = 1 AND worker_secret = p_secret) THEN
    RAISE EXCEPTION '服务凭据无效';
  END IF;
  IF p_kind NOT IN ('email','phone') THEN RAISE EXCEPTION '绑定类型不合法'; END IF;
  v := public.norm_identity(p_kind, p_value);
  IF v IS NULL THEN RAISE EXCEPTION '手机号或邮箱格式不正确'; END IF;
  BEGIN v_uid := p_uid::bigint; EXCEPTION WHEN others THEN RAISE EXCEPTION '用户标识不合法'; END;

  IF p_kind = 'phone' THEN
    SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND phone_number = v) INTO mine;
    SELECT EXISTS (SELECT 1 FROM auth.users WHERE phone_number = v AND id <> v_uid)
        OR EXISTS (SELECT 1 FROM public.profiles WHERE phone = v AND user_id <> p_uid) INTO taken;
  ELSE
    SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND lower(btrim(email)) = v) INTO mine;
    SELECT EXISTS (SELECT 1 FROM auth.users WHERE lower(btrim(email)) = v AND id <> v_uid)
        OR EXISTS (SELECT 1 FROM public.profiles WHERE lower(btrim(email)) = v AND user_id <> p_uid) INTO taken;
  END IF;

  RETURN json_build_object('state', CASE WHEN mine THEN 'mine' WHEN taken THEN 'taken' ELSE 'free' END, 'value', v);
END; $function$
;

CREATE OR REPLACE FUNCTION public.login_state_for(p_uid text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_uid bigint; v_email text; v_phone text; v_has_pwd boolean := false; methods text[] := '{}';
BEGIN
  IF p_uid IS NULL OR btrim(p_uid) = '' THEN RAISE EXCEPTION '缺少用户标识'; END IF;
  BEGIN v_uid := p_uid::bigint; EXCEPTION WHEN others THEN RAISE EXCEPTION '用户标识不合法'; END;
  SELECT u.email, u.phone_number INTO v_email, v_phone FROM auth.users u WHERE u.id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION '用户不存在'; END IF;
  SELECT COALESCE(p.has_password, false) INTO v_has_pwd FROM public.profiles p WHERE p.user_id = p_uid;
  v_has_pwd := COALESCE(v_has_pwd, false);
  IF v_email IS NOT NULL AND btrim(v_email) <> '' THEN
    methods := array_append(methods, 'email_otp');
    IF v_has_pwd THEN methods := array_append(methods, 'email_password'); END IF;
  END IF;
  IF v_phone IS NOT NULL AND btrim(v_phone) <> '' THEN
    methods := array_append(methods, 'phone_otp');
    IF v_has_pwd THEN methods := array_append(methods, 'phone_password'); END IF;
  END IF;
  RETURN json_build_object(
    'user_id', p_uid,
    'email', v_email,
    'email_verified', (v_email IS NOT NULL AND btrim(v_email) <> ''),
    'phone', v_phone,
    'phone_verified', (v_phone IS NOT NULL AND btrim(v_phone) <> ''),
    'has_password', v_has_pwd,
    'methods', to_json(methods)
  );
END; $function$
;

CREATE OR REPLACE FUNCTION public.mark_my_email(p_email text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; norm text; other text; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF; norm := lower(btrim(COALESCE(p_email, ''))); IF norm !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN RAISE EXCEPTION '邮箱格式不正确'; END IF; SELECT user_id INTO other FROM profiles WHERE lower(email) = norm AND user_id <> uid LIMIT 1; IF other IS NOT NULL THEN RAISE EXCEPTION '该邮箱已绑定到其他账号，无法重复绑定'; END IF; INSERT INTO profiles (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING; BEGIN UPDATE profiles SET email = norm, email_verified = true, email_verified_at = now(), updated_at = now() WHERE user_id = uid; EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '该邮箱已绑定到其他账号，无法重复绑定'; END; RETURN json_build_object('ok', true, 'email', norm, 'email_verified', true); END; $function$
;

CREATE OR REPLACE FUNCTION public.mark_password_set()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF; INSERT INTO profiles (user_id, has_password) VALUES (uid, true) ON CONFLICT (user_id) DO UPDATE SET has_password = true, updated_at = now(); RETURN json_build_object('ok', true, 'has_password', true); END; $function$
;
CREATE OR REPLACE FUNCTION public.my_journal_catalog(p_kw text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  prof record;
  kw text := NULLIF(btrim(coalesce(p_kw, '')), '');
  lim integer := GREATEST(LEAST(coalesce(p_limit, 200), 500), 1);
  v_rows json := '[]'::json;
  d_rows json := '[]'::json;
  v_n integer := 0;
  d_n integer := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT p.university_id, p.university_name INTO prof FROM profiles p WHERE p.user_id = uid;

  IF prof.university_id IS NOT NULL THEN
    SELECT COALESCE(json_agg(x ORDER BY x.title), '[]'::json), count(*)::int INTO v_rows, v_n
    FROM (
      SELECT s.id AS subscription_id, j.id AS journal_id, j.title, j.issn, j.eissn, j.publisher, j.subject,
             s.status, s.coverage_scope, s.coverage_years, s.database_name, s.source_url,
             s.evidence_note, s.reviewer_name, s.reviewed_at, s.is_demo
      FROM institution_journal_subscriptions s
      JOIN journals j ON j.id = s.journal_id
      WHERE s.university_id = prof.university_id AND s.status = 'verified' AND s.is_active
        AND (kw IS NULL OR j.title ILIKE '%'||kw||'%' OR coalesce(j.issn,'') ILIKE '%'||kw||'%'
             OR coalesce(j.eissn,'') ILIKE '%'||kw||'%' OR coalesce(j.publisher,'') ILIKE '%'||kw||'%'
             OR coalesce(j.subject,'') ILIKE '%'||kw||'%')
      LIMIT lim
    ) x;
    SELECT COALESCE(json_agg(y ORDER BY y.title), '[]'::json), count(*)::int INTO d_rows, d_n
    FROM (
      SELECT s.id AS subscription_id, j.id AS journal_id, j.title, j.issn, j.eissn, j.publisher, j.subject,
             s.status, s.coverage_scope, s.coverage_years, s.database_name, s.source_url,
             s.evidence_note, s.reviewer_name, s.reviewed_at, s.is_demo
      FROM institution_journal_subscriptions s
      JOIN journals j ON j.id = s.journal_id
      WHERE s.university_id = prof.university_id AND s.status = 'database_only' AND s.is_active
        AND (kw IS NULL OR j.title ILIKE '%'||kw||'%' OR coalesce(j.issn,'') ILIKE '%'||kw||'%'
             OR coalesce(j.publisher,'') ILIKE '%'||kw||'%' OR coalesce(j.subject,'') ILIKE '%'||kw||'%')
      LIMIT lim
    ) y;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'has_university', prof.university_id IS NOT NULL,
    'university_id', prof.university_id,
    'university_name', prof.university_name,
    'keyword', kw,
    'verified_count', coalesce(v_n, 0),
    'database_only_count', coalesce(d_n, 0),
    'verified', v_rows,
    'database_only', d_rows
  );
END $function$
;

CREATE OR REPLACE FUNCTION public.my_journal_submissions(p_limit integer DEFAULT 50)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  rows json;
  cnt integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) INTO rows
  FROM (
    SELECT s.id, s.journal_title, s.issn, s.eissn, s.publisher, s.subject, s.database_name,
           s.coverage_years, s.coverage_scope, s.library_url, s.evidence_note, s.remark,
           s.status, s.admin_note, s.reviewer_name, s.reviewed_at, s.created_at, s.updated_at,
           s.university_id, s.university_name, s.journal_id
    FROM journal_submissions s
    WHERE s.submitter_id = uid
    ORDER BY s.created_at DESC
    LIMIT GREATEST(LEAST(coalesce(p_limit, 50), 200), 1)
  ) t;
  SELECT count(*)::int INTO cnt FROM journal_submissions s WHERE s.submitter_id = uid;
  RETURN json_build_object('ok', true, 'total', coalesce(cnt,0), 'rows', rows);
END $function$
;

CREATE OR REPLACE FUNCTION public.my_login_state()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE uid text;
BEGIN
  uid := auth.uid();
  IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF;
  RETURN public.login_state_for(uid);
END; $function$
;

CREATE OR REPLACE FUNCTION public.my_points_overview()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; d date; acc point_accounts%ROWTYPE; checked boolean; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录'; END IF; d := (now() AT TIME ZONE 'Asia/Shanghai')::date; INSERT INTO point_accounts (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING; SELECT * INTO acc FROM point_accounts WHERE user_id = uid; SELECT EXISTS (SELECT 1 FROM point_transactions WHERE user_id = uid AND type = 'daily_checkin' AND dedupe_key = 'checkin:' || uid || ':' || to_char(d, 'YYYY-MM-DD')) INTO checked; RETURN json_build_object('today', d, 'balance', acc.balance, 'total_earned', acc.total_earned, 'total_spent', acc.total_spent, 'help_earned', acc.help_earned, 'help_count', acc.help_count, 'checked_in_today', checked); END; $function$
;

CREATE OR REPLACE FUNCTION public.my_recommend_setting()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  p record;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT pr.daily_recommend_enabled, pr.daily_recommend_updated_at, pr.recommend_subjects,
         pr.university_id, pr.university_name, pr.major, pr.college, pr.university_visibility
    INTO p FROM profiles pr WHERE pr.user_id = uid;
  RETURN json_build_object(
    'ok', true,
    'enabled', coalesce(p.daily_recommend_enabled, false),
    'updated_at', p.daily_recommend_updated_at,
    'subjects', coalesce(p.recommend_subjects, ''),
    'university_id', p.university_id,
    'university_name', p.university_name,
    'has_university', p.university_id IS NOT NULL,
    'major', p.major,
    'college', p.college
  );
END $function$
;

CREATE OR REPLACE FUNCTION public.my_requests_sorted(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; total bigint; rows json; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF; SELECT count(*) INTO total FROM help_requests WHERE owner_id = uid; SELECT COALESCE(json_agg(x), '[]'::json) INTO rows FROM ( SELECT t.* FROM ( SELECT hr.*, CASE WHEN hr.status IN ('pending_requester_review','pending_admin_review') THEN 1 WHEN hr.status IN ('open','seeking','in_progress') THEN 2 WHEN hr.status = 'completed' THEN 3 ELSE 4 END AS sort_group FROM help_requests hr WHERE hr.owner_id = uid ) t ORDER BY t.sort_group ASC, t.updated_at DESC NULLS LAST, t.id DESC LIMIT GREATEST(COALESCE(p_limit,20),1) OFFSET GREATEST(COALESCE(p_offset,0),0) ) x; RETURN json_build_object('ok', true, 'total', total, 'rows', rows); END; $function$
;

CREATE OR REPLACE FUNCTION public.my_today_recommendations()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  p record;
  terms text[];
  b record;
  n_j int := 0; n_m int := 0; n_o int := 0; n_t int := 0;
  last_b record;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;

  SELECT pr.daily_recommend_enabled, pr.university_id, pr.university_name, pr.major, pr.college, pr.recommend_subjects
    INTO p FROM profiles pr WHERE pr.user_id = uid;
  IF p IS NULL THEN RAISE EXCEPTION '账号资料不存在'; END IF;

  IF NOT coalesce(p.daily_recommend_enabled, false) THEN
    SELECT rb.batch_date, rb.total_count INTO last_b FROM recommendation_batches rb
      WHERE rb.user_id = uid ORDER BY rb.batch_date DESC LIMIT 1;
    RETURN json_build_object('ok', true, 'enabled', false, 'today', today, 'total', 0,
      'items', '[]'::json, 'has_university', p.university_id IS NOT NULL,
      'university_name', p.university_name,
      'last_batch_date', last_b.batch_date, 'last_batch_total', last_b.total_count);
  END IF;

  SELECT * INTO b FROM recommendation_batches rb WHERE rb.user_id = uid AND rb.batch_date = today;
  IF b.id IS NOT NULL THEN
    RETURN json_build_object('ok', true, 'enabled', true, 'today', today, 'batch_date', b.batch_date,
      'total', b.total_count, 'journal_count', b.journal_count, 'major_count', b.major_count,
      'other_count', b.other_count, 'generated', false,
      'has_university', p.university_id IS NOT NULL, 'university_name', p.university_name,
      'items', public.reco_items_json(b.id));
  END IF;

  terms := ARRAY(
    SELECT t FROM unnest(regexp_split_to_array(
      lower(concat_ws(' ', coalesce(p.major,''), coalesce(p.college,''), coalesce(p.recommend_subjects,''))),
      '[^[:alnum:]]+')) t
    WHERE length(t) >= 2
  );

  INSERT INTO recommendation_batches (user_id, batch_date, university_id)
  VALUES (uid, today, p.university_id) RETURNING * INTO b;

  WITH vj AS (
    SELECT s.id AS sub_id, s.journal_id, s.is_demo, j.title_norm, lower(coalesce(j.subject,'')) AS subj
    FROM institution_journal_subscriptions s
    JOIN journals j ON j.id = s.journal_id
    WHERE s.university_id = p.university_id AND s.status = 'verified' AND s.is_active
  ),
  cand AS (
    SELECT hr.id, hr.created_at, public.norm_journal_title(hr.journal) AS jn,
           lower(coalesce(hr.journal_type,'') || ' ' || coalesce(hr.journal,'')) AS hay
    FROM help_requests hr
    WHERE hr.owner_id <> uid
      AND hr.status IN ('open','seeking')
      AND NOT EXISTS (SELECT 1 FROM attachments a
                      WHERE a.request_id = hr.id AND a.status IN ('pending','approved','closed'))
      AND (hr.file_expires_at IS NULL OR hr.file_expires_at > now())
  ),
  scored AS (
    SELECT c.id, c.created_at,
      (SELECT v.sub_id FROM vj v WHERE v.title_norm = c.jn LIMIT 1) AS sub_id,
      (SELECT v.journal_id FROM vj v WHERE v.title_norm = c.jn LIMIT 1) AS jid,
      coalesce((SELECT v.is_demo FROM vj v WHERE v.title_norm = c.jn LIMIT 1), false) AS is_demo,
      CASE
        WHEN c.jn IS NOT NULL AND EXISTS (SELECT 1 FROM vj v WHERE v.title_norm = c.jn) THEN 1
        WHEN cardinality(terms) > 0 AND EXISTS (
          SELECT 1 FROM unnest(terms) tk
          WHERE length(tk) >= 2 AND (
            (c.jn IS NOT NULL AND c.jn LIKE '%' || tk || '%')
            OR c.hay LIKE '%' || tk || '%'
            OR (c.jn IS NOT NULL AND EXISTS (
                 SELECT 1 FROM journals jj
                 WHERE jj.title_norm = c.jn AND lower(coalesce(jj.subject,'')) LIKE '%' || tk || '%'))
          )
        ) THEN 2
        ELSE 3
      END AS tier,
      EXISTS (SELECT 1 FROM recommendation_items ri
              JOIN recommendation_batches rb ON rb.id = ri.batch_id
              WHERE rb.user_id = uid AND rb.batch_date > today - 7 AND ri.request_id = c.id) AS seen_before
    FROM cand c
  ),
  ranked AS (
    SELECT s.*, row_number() OVER (ORDER BY s.tier ASC, s.seen_before ASC, s.created_at DESC, s.id) AS rn
    FROM scored s
  )
  INSERT INTO recommendation_items (batch_id, request_id, rank, match_type, reason, subscription_id, journal_id, is_demo)
  SELECT b.id, r.id, r.rn,
         CASE r.tier WHEN 1 THEN 'journal' WHEN 2 THEN 'major' ELSE 'other' END,
         CASE r.tier WHEN 1 THEN '匹配本校已核验订阅期刊'
                     WHEN 2 THEN '与你的研究方向相关'
                     ELSE '其他相关求助' END,
         r.sub_id, r.jid, r.is_demo
  FROM ranked r
  WHERE r.rn <= 5;

  SELECT count(*) FILTER (WHERE match_type='journal'),
         count(*) FILTER (WHERE match_type='major'),
         count(*) FILTER (WHERE match_type='other'),
         count(*)
    INTO n_j, n_m, n_o, n_t
  FROM recommendation_items WHERE batch_id = b.id;

  UPDATE recommendation_batches
     SET journal_count = coalesce(n_j,0), major_count = coalesce(n_m,0),
         other_count = coalesce(n_o,0), total_count = coalesce(n_t,0)
   WHERE id = b.id;

  IF coalesce(n_t, 0) > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.recipient_id = uid AND n.title = '今日科研求助推荐（' || to_char(today, 'YYYY-MM-DD') || '）'
    ) THEN
      INSERT INTO notifications (recipient_id, sender_id, title, content, request_id)
      VALUES (uid, NULL,
        '今日科研求助推荐（' || to_char(today, 'YYYY-MM-DD') || '）',
        '已根据你的院校已核验期刊订阅与研究方向生成 ' || n_t || ' 条推荐，可在个人中心「今日为你推荐」查看。',
        NULL);
    END IF;
  END IF;

  RETURN json_build_object('ok', true, 'enabled', true, 'today', today, 'batch_date', today,
    'total', coalesce(n_t,0), 'journal_count', coalesce(n_j,0), 'major_count', coalesce(n_m,0),
    'other_count', coalesce(n_o,0), 'generated', true,
    'has_university', p.university_id IS NOT NULL, 'university_name', p.university_name,
    'items', public.reco_items_json(b.id));
END $function$
;

CREATE OR REPLACE FUNCTION public.my_university()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT COALESCE(( SELECT json_build_object('university_id', p.university_id, 'university_name', p.university_name, 'university_country', p.university_country, 'university_type', p.university_type, 'college', p.college, 'major', p.major, 'verified', p.university_verified, 'visibility', p.university_visibility) FROM profiles p WHERE p.user_id = auth.uid() ), '{}'::json) $function$
;

CREATE OR REPLACE FUNCTION public.norm_identity(p_kind text, p_value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE v text; d text;
BEGIN
  IF p_kind = 'phone' THEN
    d := regexp_replace(COALESCE(p_value,''), '[^0-9]', '', 'g');
    IF d LIKE '0086%' THEN d := substr(d, 5); ELSIF length(d) = 13 AND d LIKE '86%' THEN d := substr(d, 3); END IF;
    IF d !~ '^1[0-9]{10}$' THEN RETURN NULL; END IF;
    RETURN '+86 ' || d;
  ELSIF p_kind = 'email' THEN
    v := lower(btrim(COALESCE(p_value,'')));
    IF v !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN RETURN NULL; END IF;
    RETURN v;
  END IF;
  RETURN NULL;
END; $function$
;

CREATE OR REPLACE FUNCTION public.norm_journal_title(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT NULLIF(
    btrim(regexp_replace(
      btrim(regexp_replace(lower(replace(coalesce(p,''), '&', ' and ')), '[^[:alnum:]]+', ' ', 'g')),
      '^the ', '')),
    '');
$function$
;

CREATE OR REPLACE FUNCTION public.platform_stats()
 RETURNS json
 LANGUAGE sql
 STABLE
AS $function$ SELECT json_build_object('papers', (SELECT COUNT(*) FROM (SELECT COALESCE(NULLIF(btrim(doi), ''), 'T:' || regexp_replace(lower(btrim(COALESCE(title, ''))), '\s+', ' ', 'g') || '|' || lower(COALESCE(left(authors, 60), ''))) AS k FROM papers WHERE (title IS NOT NULL AND btrim(title) <> '') OR doi IS NOT NULL GROUP BY 1) d), 'requests', (SELECT COUNT(*) FROM help_requests), 'open_count', (SELECT COUNT(*) FROM help_requests WHERE status IN ('open', 'in_progress')), 'resolved_count', (SELECT COUNT(*) FROM help_requests WHERE status IN ('completed', 'resolved')), 'closed_count', (SELECT COUNT(*) FROM help_requests WHERE status = 'closed')) $function$
;

CREATE OR REPLACE FUNCTION public.point_grant(p_user_id text, p_type text, p_amount integer, p_dedupe_key text, p_request_id bigint DEFAULT NULL::bigint, p_attachment_id bigint DEFAULT NULL::bigint, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE bal integer; n integer; BEGIN IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN RAISE EXCEPTION 'point_grant: user_id required'; END IF; IF p_amount IS NULL OR p_amount = 0 THEN RAISE EXCEPTION 'point_grant: amount must be non-zero'; END IF; IF p_dedupe_key IS NULL OR btrim(p_dedupe_key) = '' THEN RAISE EXCEPTION 'point_grant: dedupe_key required'; END IF; INSERT INTO point_accounts (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING; SELECT balance INTO bal FROM point_accounts WHERE user_id = p_user_id FOR UPDATE; IF bal IS NULL THEN RAISE EXCEPTION 'point_grant: account init failed'; END IF; IF bal + p_amount < 0 THEN RAISE EXCEPTION 'INSUFFICIENT_POINTS: current %, delta %', bal, p_amount; END IF; INSERT INTO point_transactions (user_id, type, amount, balance_before, balance_after, request_id, attachment_id, dedupe_key, note) VALUES (p_user_id, p_type, p_amount, bal, bal + p_amount, p_request_id, p_attachment_id, p_dedupe_key, p_note) ON CONFLICT (dedupe_key) DO NOTHING; GET DIAGNOSTICS n = ROW_COUNT; IF n = 0 THEN RETURN json_build_object('applied', false, 'balance', bal, 'reason', 'duplicate'); END IF; UPDATE point_accounts SET balance = balance + p_amount, total_earned = GREATEST(0, total_earned + (CASE WHEN p_amount > 0 AND p_type <> 'bounty_refund' THEN p_amount ELSE 0 END)), total_spent = GREATEST(0, total_spent + (CASE WHEN p_type = 'bounty_refund' THEN -p_amount WHEN p_amount < 0 THEN -p_amount ELSE 0 END)), help_earned = help_earned + (CASE WHEN p_type = 'bounty_reward' THEN p_amount ELSE 0 END), help_count = help_count + (CASE WHEN p_type = 'bounty_reward' THEN 1 ELSE 0 END), updated_at = now() WHERE user_id = p_user_id; RETURN json_build_object('applied', true, 'balance', bal + p_amount, 'amount', p_amount, 'type', p_type); END; $function$
;

CREATE OR REPLACE FUNCTION public.reco_items_json(p_batch_id bigint)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(json_agg(x ORDER BY x.rank), '[]'::json) FROM (
    SELECT ri.rank, ri.match_type, ri.reason, ri.is_demo, ri.request_id, ri.subscription_id,
           hr.paper_title, hr.doi, hr.journal, hr.published_year, hr.description, hr.status,
           hr.created_at AS request_created_at, hr.bounty_points, hr.file_expires_at,
           j.publisher, j.issn,
           s.coverage_years, s.coverage_scope, s.database_name,
           s.status AS subscription_status, s.is_demo AS subscription_is_demo
    FROM recommendation_items ri
    JOIN help_requests hr ON hr.id = ri.request_id
    LEFT JOIN journals j ON j.id = ri.journal_id
    LEFT JOIN institution_journal_subscriptions s ON s.id = ri.subscription_id
    WHERE ri.batch_id = p_batch_id
  ) x
$function$
;

CREATE OR REPLACE FUNCTION public.record_file_delete_result(p_attachment_id bigint, p_ok boolean, p_error text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; att attachments%ROWTYPE; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录'; END IF; SELECT * INTO att FROM attachments WHERE id = p_attachment_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '附件不存在'; END IF; IF att.owner_id IS DISTINCT FROM uid AND NOT is_admin() THEN RAISE EXCEPTION '只有文件属主或管理员可以上报删除结果'; END IF; IF p_ok THEN UPDATE attachments SET file_delete_attempts = file_delete_attempts + 1, file_delete_error = NULL WHERE id = p_attachment_id; ELSE UPDATE attachments SET file_delete_attempts = file_delete_attempts + 1, file_delete_error = COALESCE(NULLIF(btrim(p_error), ''), '未知错误') WHERE id = p_attachment_id; END IF; RETURN json_build_object('ok', true, 'deleted', p_ok, 'attempts', att.file_delete_attempts + 1); END; $function$
;

CREATE OR REPLACE FUNCTION public.request_email_bind(p_email text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; norm text; other text; code text; salt text; cid bigint; recent int; last_at timestamptz; link text; body_txt text; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录后再绑定邮箱'; END IF; norm := lower(btrim(COALESCE(p_email, ''))); IF norm !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN RAISE EXCEPTION '邮箱格式不正确'; END IF; SELECT user_id INTO other FROM profiles WHERE lower(email) = norm AND user_id <> uid LIMIT 1; IF other IS NOT NULL THEN RAISE EXCEPTION '该邮箱已绑定到其他账号，不能重复绑定'; END IF; SELECT count(*), max(created_at) INTO recent, last_at FROM email_verify_codes WHERE user_id = uid AND created_at > now() - interval '10 minutes'; IF last_at IS NOT NULL AND now() - last_at < interval '60 seconds' THEN RAISE EXCEPTION '发送过于频繁，请 1 分钟后再试'; END IF; IF recent >= 3 THEN RAISE EXCEPTION '验证码请求过于频繁，请 10 分钟后再试'; END IF; UPDATE email_verify_codes SET consumed_at = now() WHERE user_id = uid AND consumed_at IS NULL; code := lpad((floor(random() * 1000000))::int::text, 6, '0'); salt := md5(random()::text || clock_timestamp()::text); INSERT INTO email_verify_codes (user_id, email, purpose, code_hash, salt, expires_at) VALUES (uid, norm, 'bind_email', md5(code || salt), salt, now() + interval '5 minutes') RETURNING id INTO cid; link := 'https://research-aid.app.workbuddy.host/profile.html'; body_txt := '你正在为科研互助平台账号绑定邮箱，验证码：' || code || E'\n\n' || '该验证码 5 分钟内有效，且只能使用一次。若非本人操作，请忽略本邮件。' || E'\n\n' || '绑定后可用于接收求助审核提醒邮件，并在支持时用于账号密码找回。' || E'\n\n' || '个人中心：' || link; PERFORM enqueue_email(uid, norm, NULL, NULL, 'bind_email', '科研互助平台：邮箱绑定验证码', body_txt, 'bind_code:' || cid); RETURN json_build_object('ok', true, 'email', norm, 'expires_in', 300); END; $function$
;
CREATE OR REPLACE FUNCTION public.resolve_journal(p_title text, p_issn text DEFAULT NULL::text, p_eissn text DEFAULT NULL::text, p_publisher text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_url text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n text := public.norm_journal_title(p_title);
  jid bigint;
  issn_clean text := nullif(btrim(coalesce(p_issn, '')), '');
BEGIN
  IF n IS NULL THEN RAISE EXCEPTION '期刊名称不能为空'; END IF;
  IF issn_clean IS NOT NULL THEN
    SELECT id INTO jid FROM journals WHERE issn = issn_clean OR eissn = issn_clean LIMIT 1;
    IF jid IS NOT NULL THEN RETURN jid; END IF;
  END IF;
  SELECT id INTO jid FROM journals WHERE title_norm = n LIMIT 1;
  IF jid IS NOT NULL THEN RETURN jid; END IF;
  INSERT INTO journals (title, title_norm, issn, eissn, publisher, subject, official_url)
  VALUES (btrim(p_title), n, issn_clean,
          nullif(btrim(coalesce(p_eissn, '')), ''),
          nullif(btrim(coalesce(p_publisher, '')), ''),
          nullif(btrim(coalesce(p_subject, '')), ''),
          nullif(btrim(coalesce(p_url, '')), ''))
  ON CONFLICT (title_norm) DO UPDATE SET updated_at = now()
  RETURNING id INTO jid;
  RETURN jid;
END $function$
;

CREATE OR REPLACE FUNCTION public.review_attachment(att_id bigint, action text, note text DEFAULT ''::text, reviewer_name text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE att attachments%ROWTYPE; req help_requests%ROWTYPE; closed_count int; pay json; paid boolean := false; pay_points integer := 0; exp_at timestamptz; BEGIN IF auth.uid() IS NULL OR auth.uid() = '' THEN RAISE EXCEPTION '请先登录'; END IF; SELECT * INTO att FROM attachments WHERE id = att_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '附件不存在'; END IF; SELECT * INTO req FROM help_requests WHERE id = att.request_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '关联求助不存在'; END IF; IF req.owner_id IS DISTINCT FROM auth.uid() AND NOT is_admin() THEN RAISE EXCEPTION '只有该求助的发布者或管理员可以审核附件'; END IF; IF req.status IN ('completed','closed','invalid') THEN RAISE EXCEPTION '该求助已结束，不能重复审核或重复发放悬赏'; END IF; IF att.status <> 'pending' THEN RAISE EXCEPTION '该附件当前不是待审核状态（当前状态：%）', att.status; END IF; IF action = 'approve' THEN IF att.owner_id IS NOT DISTINCT FROM req.owner_id THEN RAISE EXCEPTION '不能为自己发布的求助发放悬赏积分'; END IF; exp_at := now() + interval '48 hours'; UPDATE attachments SET status='approved', review_note=NULLIF(note,''), reviewed_by=auth.uid(), reviewed_at=now(), expires_at=exp_at WHERE id=att_id; UPDATE attachments SET status='closed', review_note='求助已完成，该附件未被采纳', reviewed_by=auth.uid(), reviewed_at=now(), expires_at=exp_at WHERE request_id=req.id AND status IN ('pending','rejected_by_requester') AND id<>att_id; GET DIAGNOSTICS closed_count = ROW_COUNT; UPDATE help_requests SET status='completed', updated_at=now(), completed_at=now(), completed_by=auth.uid(), file_expires_at=exp_at, file_cleanup_status='pending' WHERE id=req.id; pay_points := COALESCE(req.bounty_points, 0); IF req.bounty_status = 'locked' AND pay_points > 0 THEN pay := point_grant(att.owner_id, 'bounty_reward', pay_points, 'bounty_reward:' || req.id, req.id, att.id, '求助 #' || req.id || ' 审核通过，获得悬赏 ' || pay_points || ' 积分'); paid := COALESCE((pay->>'applied')::boolean, false); IF paid THEN UPDATE help_requests SET bounty_status='paid', bounty_paid_at=now(), bounty_paid_to=att.owner_id WHERE id=req.id AND bounty_status='locked'; END IF; END IF; INSERT INTO review_logs (attachment_id, action, note, reviewer_name) VALUES (att_id, 'approve', NULLIF(note,''), reviewer_name); INSERT INTO notifications (recipient_id, request_id, title, content) VALUES (att.owner_id, req.id, '附件审核通过', '你上传的附件「' || att.file_name || '」已审核通过，求助 #' || req.id || ' 已完成' || CASE WHEN paid THEN '，悬赏 ' || pay_points || ' 积分已到账。' ELSE '（该求助无预留悬赏，不发放积分）。' END); RETURN json_build_object('ok', true, 'action', 'approve', 'closed_others', closed_count, 'bounty_paid', paid, 'bounty_points', CASE WHEN paid THEN pay_points ELSE 0 END, 'file_expires_at', exp_at); ELSIF action = 'reject' THEN IF NULLIF(note,'') IS NULL THEN RAISE EXCEPTION '审核不通过时必须填写审核意见'; END IF; UPDATE attachments SET status='rejected_by_requester', review_note=note, reviewed_by=auth.uid(), reviewed_at=now() WHERE id=att_id; UPDATE help_requests SET status='pending_admin_review', updated_at=now() WHERE id=req.id; INSERT INTO review_tasks (request_id, attachment_id, requester_note) VALUES (req.id, att_id, note); INSERT INTO review_logs (attachment_id, action, note, reviewer_name) VALUES (att_id, 'reject', note, reviewer_name); INSERT INTO notifications (recipient_id, request_id, title, content) VALUES (att.owner_id, req.id, '附件初审未通过，等待管理员复核', '你上传的附件「' || att.file_name || '」初审未通过（求助 #' || req.id || '）。审核意见：' || note || '。已提交管理员复核，复核期间悬赏积分暂不支付或退还。'); RETURN json_build_object('ok', true, 'action', 'reject', 'request_status', 'pending_admin_review', 'bounty_paid', false); ELSE RAISE EXCEPTION '无效的审核动作：%', action; END IF; END; $function$
;

CREATE OR REPLACE FUNCTION public.search_universities(p_kw text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_limit integer DEFAULT 20)
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT COALESCE(json_agg(t ORDER BY t.name), '[]'::json) FROM ( SELECT u.id, u.name, u.country, u.region, u.type FROM universities u WHERE u.is_verified = true AND (p_country IS NULL OR btrim(p_country) = '' OR u.country = p_country) AND (p_kw IS NULL OR btrim(p_kw) = '' OR u.name ILIKE '%' || btrim(p_kw) || '%') ORDER BY u.name LIMIT GREATEST(COALESCE(p_limit, 20), 1) ) t $function$
;

CREATE OR REPLACE FUNCTION public.set_my_nickname(nick text)
 RETURNS json
 LANGUAGE plpgsql
AS $function$ DECLARE uid text; n text; req_cnt int; BEGIN uid := auth.uid(); IF uid IS NULL OR uid = '' THEN RAISE EXCEPTION '请先登录后再设置昵称'; END IF; n := btrim(COALESCE(nick, '')); IF char_length(n) < 2 OR char_length(n) > 20 THEN RAISE EXCEPTION '昵称长度需为 2～20 个字符（当前 % 个字符）', char_length(n); END IF; IF n !~ '^[0-9A-Za-z一-龥_·. -]+$' THEN RAISE EXCEPTION '昵称只能包含中文、英文、数字、空格以及 _ · . - 符号'; END IF; INSERT INTO profiles (user_id, nickname, updated_at) VALUES (uid, n, now()) ON CONFLICT (user_id) DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = now(); UPDATE help_requests SET owner_name = n WHERE owner_id = uid; GET DIAGNOSTICS req_cnt = ROW_COUNT; UPDATE attachments SET owner_name = n WHERE owner_id = uid; RETURN json_build_object('ok', true, 'nickname', n, 'requests_updated', req_cnt); END; $function$
;

CREATE OR REPLACE FUNCTION public.set_my_recommend_setting(p_enabled boolean, p_subjects text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  subj text := nullif(btrim(coalesce(p_subjects,'')), '');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = uid) THEN RAISE EXCEPTION '账号资料不存在'; END IF;
  IF subj IS NOT NULL AND length(subj) > 200 THEN RAISE EXCEPTION '学科标签过长'; END IF;
  UPDATE profiles SET
    daily_recommend_enabled = coalesce(p_enabled, false),
    daily_recommend_updated_at = now(),
    recommend_subjects = subj
  WHERE user_id = uid;
  RETURN json_build_object('ok', true, 'enabled', coalesce(p_enabled, false), 'subjects', coalesce(subj, ''));
END $function$
;

CREATE OR REPLACE FUNCTION public.set_my_university(p_university_id bigint DEFAULT NULL::bigint, p_name text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_college text DEFAULT NULL::text, p_major text DEFAULT NULL::text, p_visibility text DEFAULT 'private'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; u universities%ROWTYPE; nm text; ctry text; tp text; verified boolean := false; vis text; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录后再保存院校信息'; END IF; vis := CASE WHEN p_visibility = 'public' THEN 'public' ELSE 'private' END; IF p_university_id IS NOT NULL THEN SELECT * INTO u FROM universities WHERE id = p_university_id; IF NOT FOUND THEN RAISE EXCEPTION '院校不存在，请重新选择'; END IF; nm := u.name; ctry := u.country; tp := u.type; verified := u.is_verified; ELSE nm := NULLIF(btrim(COALESCE(p_name, '')), ''); IF nm IS NULL THEN RAISE EXCEPTION '请填写院校名称或从列表中选择'; END IF; ctry := NULLIF(btrim(COALESCE(p_country, '')), ''); IF ctry IS NULL THEN RAISE EXCEPTION '手动填写院校时必须选择国家或地区'; END IF; tp := NULLIF(btrim(COALESCE(p_type, '')), ''); verified := false; END IF; INSERT INTO profiles (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING; UPDATE profiles SET university_id = p_university_id, university_name = nm, university_country = ctry, university_type = tp, college = NULLIF(btrim(COALESCE(p_college, '')), ''), major = NULLIF(btrim(COALESCE(p_major, '')), ''), university_verified = verified, university_visibility = vis, updated_at = now() WHERE user_id = uid; RETURN json_build_object('ok', true, 'university_id', p_university_id, 'university_name', nm, 'university_country', ctry, 'university_type', tp, 'verified', verified, 'visibility', vis); END; $function$
;

CREATE OR REPLACE FUNCTION public.set_request_status(p_request_id bigint, p_status text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; req help_requests%ROWTYPE; res json; refunded boolean := false; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录'; END IF; IF p_status NOT IN ('open','seeking','closed') THEN RAISE EXCEPTION '不支持的状态：%', p_status; END IF; SELECT * INTO req FROM help_requests WHERE id = p_request_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION '求助不存在'; END IF; IF req.owner_id IS DISTINCT FROM uid AND NOT is_admin() THEN RAISE EXCEPTION '只有求助发布者或管理员可以修改该求助状态'; END IF; IF req.status = 'completed' THEN RAISE EXCEPTION '已完成的求助不能再修改状态'; END IF; IF req.status IN ('pending_requester_review','pending_admin_review') THEN RAISE EXCEPTION '该求助已有应助文件正在审核/复核中，不能取消或关闭，也不能申请退还悬赏'; END IF; UPDATE help_requests SET status = p_status, updated_at = now() WHERE id = p_request_id; IF p_status = 'closed' AND req.bounty_status = 'locked' AND COALESCE(req.bounty_points, 0) > 0 THEN res := point_grant(req.owner_id, 'bounty_refund', req.bounty_points, 'bounty_refund:' || req.id, req.id, NULL, '关闭 / 取消求助 #' || req.id || '，退还预留悬赏 ' || req.bounty_points || ' 积分'); refunded := COALESCE((res->>'applied')::boolean, false); IF refunded THEN UPDATE help_requests SET bounty_status = 'refunded', bounty_refunded_at = now() WHERE id = req.id; END IF; END IF; RETURN json_build_object('ok', true, 'id', req.id, 'status', p_status, 'refunded', refunded, 'refund_points', CASE WHEN refunded THEN req.bounty_points ELSE 0 END); END; $function$
;

CREATE OR REPLACE FUNCTION public.square_list(p_kw text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE total bigint; rows json; kw text; BEGIN kw := NULLIF(btrim(COALESCE(p_kw, '')), ''); SELECT count(*) INTO total FROM help_requests hr WHERE hr.status IN ('open','seeking') AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.request_id = hr.id AND a.status IN ('pending','rejected_by_requester')) AND (kw IS NULL OR hr.paper_title ILIKE '%' || kw || '%' OR hr.doi ILIKE '%' || kw || '%' OR hr.description ILIKE '%' || kw || '%' OR hr.authors ILIKE '%' || kw || '%' OR hr.journal ILIKE '%' || kw || '%'); SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) INTO rows FROM ( SELECT hr.* FROM help_requests hr WHERE hr.status IN ('open','seeking') AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.request_id = hr.id AND a.status IN ('pending','rejected_by_requester')) AND (kw IS NULL OR hr.paper_title ILIKE '%' || kw || '%' OR hr.doi ILIKE '%' || kw || '%' OR hr.description ILIKE '%' || kw || '%' OR hr.authors ILIKE '%' || kw || '%' OR hr.journal ILIKE '%' || kw || '%') ORDER BY hr.created_at DESC LIMIT GREATEST(COALESCE(p_limit,10),1) OFFSET GREATEST(COALESCE(p_offset,0),0) ) t; RETURN json_build_object('ok', true, 'total', total, 'rows', rows); END; $function$
;

CREATE OR REPLACE FUNCTION public.submit_journal_subscription(p_journal_title text, p_issn text DEFAULT NULL::text, p_eissn text DEFAULT NULL::text, p_publisher text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_database_name text DEFAULT NULL::text, p_coverage_years text DEFAULT NULL::text, p_coverage_scope text DEFAULT NULL::text, p_library_url text DEFAULT NULL::text, p_evidence_note text DEFAULT NULL::text, p_remark text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  prof record;
  n text;
  new_id bigint;
  dup_id bigint;
  u text := nullif(btrim(coalesce(p_library_url,'')), '');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF length(btrim(coalesce(p_journal_title,''))) < 2 THEN RAISE EXCEPTION '请填写期刊正式名称'; END IF;
  IF length(btrim(p_journal_title)) > 200 THEN RAISE EXCEPTION '期刊名称过长'; END IF;
  IF u IS NOT NULL AND u !~* '^https?://' THEN RAISE EXCEPTION '官方图书馆资源页面链接需以 http(s):// 开头'; END IF;

  SELECT p.university_id, p.university_name, p.nickname INTO prof FROM profiles p WHERE p.user_id = uid;
  IF prof.university_id IS NULL THEN RAISE EXCEPTION '请先在院校信息中完善所属院校，再提交期刊订阅信息'; END IF;

  n := public.norm_journal_title(p_journal_title);

  SELECT s.id INTO dup_id FROM journal_submissions s
   WHERE s.submitter_id = uid AND s.university_id = prof.university_id
     AND s.status IN ('pending','need_info')
     AND public.norm_journal_title(s.journal_title) = n
   LIMIT 1;
  IF dup_id IS NOT NULL THEN
    RETURN json_build_object('ok', true, 'duplicate', true, 'id', dup_id, 'status', 'pending',
      'message', '同一院校下该期刊已有待审核的提交，可在「我的提交记录」中查看或修改');
  END IF;

  INSERT INTO journal_submissions (
    submitter_id, submitter_name, university_id, university_name, journal_id, journal_title,
    issn, eissn, publisher, subject, database_name, coverage_years, coverage_scope,
    library_url, evidence_note, remark, status)
  VALUES (
    uid, prof.nickname, prof.university_id, prof.university_name,
    (SELECT j.id FROM journals j WHERE (nullif(btrim(coalesce(p_issn,'')),'') IS NOT NULL AND (j.issn = btrim(p_issn) OR j.eissn = btrim(p_issn))) OR j.title_norm = n LIMIT 1),
    btrim(p_journal_title),
    nullif(btrim(coalesce(p_issn,'')), ''), nullif(btrim(coalesce(p_eissn,'')), ''),
    nullif(btrim(coalesce(p_publisher,'')), ''), nullif(btrim(coalesce(p_subject,'')), ''),
    nullif(btrim(coalesce(p_database_name,'')), ''), nullif(btrim(coalesce(p_coverage_years,'')), ''),
    nullif(btrim(coalesce(p_coverage_scope,'')), ''), u,
    nullif(btrim(coalesce(p_evidence_note,'')), ''), nullif(btrim(coalesce(p_remark,'')), ''),
    'pending')
  RETURNING id INTO new_id;

  INSERT INTO journal_review_logs (submission_id, university_id, action, note, reviewer_id, reviewer_name)
  VALUES (new_id, prof.university_id, 'submit', '用户提交期刊订阅信息，等待管理员核实', uid, prof.nickname);

  RETURN json_build_object('ok', true, 'duplicate', false, 'id', new_id, 'status', 'pending',
    'message', '提交成功，状态为待管理员审核');
END $function$
;

CREATE OR REPLACE FUNCTION public.sync_session_email()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE uid text; jwt_email text; cur_email text; cur_verified boolean; other text; BEGIN uid := auth.uid(); IF uid IS NULL OR btrim(uid) = '' OR uid = 'anon' THEN RAISE EXCEPTION '请先登录'; END IF; jwt_email := lower(btrim(COALESCE(auth.jwt() ->> 'email', ''))); IF jwt_email = '' THEN RETURN json_build_object('ok', true, 'synced', false, 'reason', 'no_email_in_session'); END IF; IF jwt_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN RETURN json_build_object('ok', true, 'synced', false, 'reason', 'bad_email'); END IF; SELECT email, COALESCE(email_verified, false) INTO cur_email, cur_verified FROM profiles WHERE user_id = uid; IF lower(COALESCE(cur_email, '')) = jwt_email AND COALESCE(cur_verified, false) THEN RETURN json_build_object('ok', true, 'synced', false, 'email', jwt_email, 'reason', 'already'); END IF; IF cur_email IS NOT NULL AND lower(cur_email) <> jwt_email THEN RAISE EXCEPTION '当前账号已绑定其他邮箱，如需变更请先在个人中心完成新邮箱验证'; END IF; SELECT user_id INTO other FROM profiles WHERE lower(email) = jwt_email AND user_id <> uid LIMIT 1; IF other IS NOT NULL THEN RAISE EXCEPTION '该邮箱已绑定到其他账号'; END IF; INSERT INTO profiles (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING; BEGIN UPDATE profiles SET email = jwt_email, email_verified = true, email_verified_at = now(), updated_at = now() WHERE user_id = uid; EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '该邮箱已绑定到其他账号'; END; RETURN json_build_object('ok', true, 'synced', true, 'email', jwt_email, 'email_verified', true); END; $function$
;

CREATE OR REPLACE FUNCTION public.trg_help_request_bounty_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN IF NEW.bounty_points IS NULL THEN RAISE EXCEPTION '悬赏积分不能为空'; END IF; IF NEW.bounty_points NOT IN (0, 5) THEN RAISE EXCEPTION '悬赏积分必须由服务端固定为 5（当前 %）', NEW.bounty_points; END IF; IF NEW.bounty_status = 'none' THEN IF NEW.bounty_points <> 0 THEN RAISE EXCEPTION '无悬赏求助的悬赏积分必须为 0'; END IF; RETURN NULL; END IF; IF NEW.bounty_points <> 5 THEN RAISE EXCEPTION '有悬赏记录的求助，悬赏积分必须为 5'; END IF; IF NOT EXISTS (SELECT 1 FROM point_transactions WHERE type = 'bounty_lock' AND request_id = NEW.id AND dedupe_key = 'bounty_lock:' || NEW.id AND amount = -NEW.bounty_points) THEN RAISE EXCEPTION '求助必须通过服务端函数创建并完成悬赏预留记账（缺少 bounty_lock 交易）'; END IF; IF NEW.bounty_status = 'paid' AND NOT EXISTS (SELECT 1 FROM point_transactions WHERE type = 'bounty_reward' AND request_id = NEW.id AND dedupe_key = 'bounty_reward:' || NEW.id AND amount = NEW.bounty_points) THEN RAISE EXCEPTION '悬赏支付缺少对应的 bounty_reward 交易记录'; END IF; IF NEW.bounty_status = 'refunded' AND NOT EXISTS (SELECT 1 FROM point_transactions WHERE type = 'bounty_refund' AND request_id = NEW.id AND dedupe_key = 'bounty_refund:' || NEW.id AND amount = NEW.bounty_points) THEN RAISE EXCEPTION '悬赏退款缺少对应的 bounty_refund 交易记录'; END IF; RETURN NULL; END; $function$
;

CREATE OR REPLACE FUNCTION public.update_journal_submission(p_id bigint, p_journal_title text DEFAULT NULL::text, p_issn text DEFAULT NULL::text, p_eissn text DEFAULT NULL::text, p_publisher text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_database_name text DEFAULT NULL::text, p_coverage_years text DEFAULT NULL::text, p_coverage_scope text DEFAULT NULL::text, p_library_url text DEFAULT NULL::text, p_evidence_note text DEFAULT NULL::text, p_remark text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  row_rec record;
  nm text;
  u text := nullif(btrim(coalesce(p_library_url,'')), '');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO row_rec FROM journal_submissions WHERE id = p_id FOR UPDATE;
  IF row_rec.id IS NULL THEN RAISE EXCEPTION '提交记录不存在'; END IF;
  IF row_rec.submitter_id <> uid THEN RAISE EXCEPTION '只能修改自己提交的记录'; END IF;
  IF row_rec.status NOT IN ('pending','need_info','rejected') THEN
    RAISE EXCEPTION '当前状态（%）不允许修改', row_rec.status;
  END IF;
  IF p_journal_title IS NOT NULL AND length(btrim(p_journal_title)) < 2 THEN RAISE EXCEPTION '请填写期刊正式名称'; END IF;
  IF u IS NOT NULL AND u !~* '^https?://' THEN RAISE EXCEPTION '官方图书馆资源页面链接需以 http(s):// 开头'; END IF;

  nm := coalesce(nullif(btrim(coalesce(p_journal_title,'')), ''), row_rec.journal_title);

  UPDATE journal_submissions SET
    journal_title = nm,
    issn = coalesce(nullif(btrim(coalesce(p_issn,'')), ''), issn),
    eissn = coalesce(nullif(btrim(coalesce(p_eissn,'')), ''), eissn),
    publisher = coalesce(nullif(btrim(coalesce(p_publisher,'')), ''), publisher),
    subject = coalesce(nullif(btrim(coalesce(p_subject,'')), ''), subject),
    database_name = coalesce(nullif(btrim(coalesce(p_database_name,'')), ''), database_name),
    coverage_years = coalesce(nullif(btrim(coalesce(p_coverage_years,'')), ''), coverage_years),
    coverage_scope = coalesce(nullif(btrim(coalesce(p_coverage_scope,'')), ''), coverage_scope),
    library_url = coalesce(u, library_url),
    evidence_note = coalesce(nullif(btrim(coalesce(p_evidence_note,'')), ''), evidence_note),
    remark = coalesce(nullif(btrim(coalesce(p_remark,'')), ''), remark),
    journal_id = (SELECT j.id FROM journals j WHERE j.title_norm = public.norm_journal_title(nm) LIMIT 1),
    status = 'pending',
    admin_note = NULL,
    reviewed_by = NULL,
    reviewer_name = NULL,
    reviewed_at = NULL,
    updated_at = now()
  WHERE id = p_id;

  INSERT INTO journal_review_logs (submission_id, university_id, action, note, reviewer_id, reviewer_name)
  VALUES (p_id, row_rec.university_id, 'resubmit', '用户修改并重新提交，状态回到待审核', uid, row_rec.submitter_name);

  RETURN json_build_object('ok', true, 'id', p_id, 'status', 'pending');
END $function$
;

CREATE OR REPLACE FUNCTION public.upload_attachment(p_request_id bigint, p_file_name text, p_file_path text, p_size_bytes bigint, p_owner_name text, p_oa_source_url text DEFAULT NULL::text, p_license_type text DEFAULT NULL::text, p_license_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text;
  req help_requests%ROWTYPE;
  aid bigint;
  ban_until timestamptz;
  owner_email text;
  uploader_email text;
  link text;
  body_txt text;
  base text;
  code text;
BEGIN
  uid := auth.uid();
  IF uid IS NULL OR btrim(uid) = '' THEN RAISE EXCEPTION '请先登录后再上传文件'; END IF;

  SELECT ends_at INTO ban_until FROM bans WHERE user_id = uid AND now() < ends_at ORDER BY ends_at DESC LIMIT 1;
  IF ban_until IS NOT NULL THEN RAISE EXCEPTION '你正处于封禁期，暂不能上传应助文件。解封时间：%', to_char(ban_until, 'YYYY-MM-DD HH24:MI'); END IF;

  SELECT * INTO req FROM help_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '求助不存在'; END IF;
  IF req.status NOT IN ('open','seeking') THEN RAISE EXCEPTION '该求助当前不接受新的应助文件（状态：%）', req.status; END IF;
  IF req.owner_id IS NOT DISTINCT FROM uid THEN RAISE EXCEPTION '不能给自己的求助上传应助文件'; END IF;
  IF EXISTS (SELECT 1 FROM attachments WHERE request_id = p_request_id AND status IN ('pending','rejected_by_requester')) THEN RAISE EXCEPTION '该求助已有待审核的应助文件，请等待求助人审核后再试'; END IF;

  INSERT INTO attachments (owner_id, owner_name, request_id, file_name, file_path, size_bytes, status, oa_source_url, license_type, license_note, share_confirmed)
  VALUES (uid, p_owner_name, p_request_id, p_file_name, p_file_path, p_size_bytes, 'pending', p_oa_source_url, p_license_type, p_license_note, true)
  RETURNING id INTO aid;

  IF p_file_path IS NOT NULL AND btrim(p_file_path) <> '' THEN
    INSERT INTO attachment_files (attachment_id, file_path) VALUES (aid, p_file_path);
  END IF;

  UPDATE help_requests SET status = 'pending_requester_review', updated_at = now() WHERE id = p_request_id;

  INSERT INTO notifications (recipient_id, request_id, title, content)
  VALUES (req.owner_id, req.id, '你的求助收到新的应助文件',
    '求助 #' || req.id || ' 收到 ' || COALESCE(NULLIF(btrim(p_owner_name),''), '一位用户') || ' 上传的应助文件「' || p_file_name || '」，请前往详情页审核。');

  SELECT COALESCE(NULLIF(s.public_base_url,''), 'https://research-aid.app.workbuddy.host'), NULLIF(s.share_code,'')
    INTO base, code
    FROM app_secret s WHERE s.id = 1;
  base := COALESCE(NULLIF(btrim(base),''), 'https://research-aid.app.workbuddy.host');
  link := base || '/request.html?id=' || req.id || COALESCE('&sharecode=' || code, '');

  BEGIN
    SELECT p.email INTO owner_email FROM profiles p WHERE p.user_id = req.owner_id AND p.email_verified = true LIMIT 1;
    IF owner_email IS NOT NULL THEN
      body_txt := '你的求助已收到新的应助文件，请尽快登录科研互助平台查看文件是否符合求助要求。请根据平台页面显示的状态完成审核。' || E'\n\n'
        || '求助编号：求助 #' || req.id || E'\n'
        || '论文标题：' || COALESCE(req.paper_title, '（未填写）') || E'\n'
        || 'DOI：' || COALESCE(req.doi, '（未提供）') || E'\n'
        || '期刊名称：' || COALESCE(req.journal, '（未提供）') || E'\n'
        || '应助人：' || COALESCE(NULLIF(btrim(p_owner_name),''), '一位用户') || E'\n'
        || '文件名称：' || p_file_name || E'\n'
        || '上传时间：' || to_char(now(), 'YYYY-MM-DD HH24:MI') || E'\n'
        || '当前状态：待求助人审核' || E'\n\n'
        || '审核通过后，文件将按照平台规则开放下载，并在求助完成 48 小时后自动清理，请及时下载和保存。' || E'\n'
        || '审核不通过时，会转交管理员复核；复核期间悬赏积分暂不支付或退还。' || E'\n\n'
        || '查看求助详情：' || link;
      PERFORM enqueue_email(req.owner_id, owner_email, req.id, aid, 'review_request',
        '科研互助平台：你的求助收到新的应助文件，请及时审核', body_txt, 'review_email:' || aid);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO email_enqueue_log (request_id, attachment_id, recipient_id, recipient_email, kind, error)
      VALUES (req.id, aid, req.owner_id, owner_email, 'review_request', left(SQLERRM, 300));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;

  BEGIN
    SELECT p.email INTO uploader_email FROM profiles p WHERE p.user_id = uid AND p.email_verified = true LIMIT 1;
    IF uploader_email IS NOT NULL THEN
      body_txt := '你上传的应助文件已成功提交，当前处于待审核状态。' || E'\n\n'
        || '求助编号：求助 #' || req.id || E'\n'
        || '文件名称：' || p_file_name || E'\n'
        || '上传时间：' || to_char(now(), 'YYYY-MM-DD HH24:MI') || E'\n'
        || '当前状态：待求助人审核' || E'\n\n'
        || '如审核通过，悬赏积分将自动到账；如审核不通过，会转交管理员复核。' || E'\n'
        || '查看求助详情：' || link;
      PERFORM enqueue_email(uid, uploader_email, req.id, aid, 'upload_receipt',
        '科研互助平台：你的应助文件已提交，等待审核', body_txt, 'upload_receipt:' || aid);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO email_enqueue_log (request_id, attachment_id, recipient_id, recipient_email, kind, error)
      VALUES (req.id, aid, uid, uploader_email, 'upload_receipt', left(SQLERRM, 300));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;

  RETURN json_build_object('ok', true, 'attachment_id', aid, 'request_status', 'pending_requester_review');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.withdraw_journal_submission(p_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid text := auth.uid();
  row_rec record;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO row_rec FROM journal_submissions WHERE id = p_id FOR UPDATE;
  IF row_rec.id IS NULL THEN RAISE EXCEPTION '提交记录不存在'; END IF;
  IF row_rec.submitter_id <> uid THEN RAISE EXCEPTION '只能撤回自己的提交'; END IF;
  IF row_rec.status NOT IN ('pending','need_info','rejected') THEN RAISE EXCEPTION '当前状态不允许撤回'; END IF;
  UPDATE journal_submissions SET status = 'withdrawn', updated_at = now() WHERE id = p_id;
  INSERT INTO journal_review_logs (submission_id, university_id, action, note, reviewer_id, reviewer_name)
  VALUES (p_id, row_rec.university_id, 'withdraw', '用户撤回提交', uid, row_rec.submitter_name);
  RETURN json_build_object('ok', true, 'id', p_id, 'status', 'withdrawn');
END $function$
;
