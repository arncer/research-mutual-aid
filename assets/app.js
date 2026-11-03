/* 科研互助平台 - 公共脚本 */
(function () {
  'use strict';

  // ---- 云服务 SDK 可用性兜底 ----
  // SDK 由 assets/workbuddy-cloud-sdk.js 同域加载。若它没被成功加载（网络拦截、
  // 部署包缺文件、缓存损坏），历史版本会在这里直接抛错，导致整段脚本中断：
  // 页面只剩静态骨架，「…」占位永不更新，而且控制台之外看不到任何提示。
  // 这里改为显式降级：把占位换成「—」，并在最新求助区域给出可读的失败原因。
  if (!window.WorkBuddyCloud) {
    var showSdkFailure = function () {
      ['stat-papers', 'stat-requests', 'stat-open', 'stat-resolved'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.textContent = '—';
      });
      var box = document.getElementById('latest') || document.getElementById('list');
      if (box) box.innerHTML = '<p class="muted">云服务组件未能加载，页面数据暂时不可用。请刷新重试；若仍失败，请检查网络后联系管理员。</p>';
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showSdkFailure);
    } else {
      showSdkFailure();
    }
    return;
  }

  // Keep browser cloud calls same-origin; server.js relays them with user credentials.
  // Leave room for multipart overhead below Vercel's 4.5 MB request limit.
  var UPLOAD_LIMIT_MB = location.hostname === 'research-aid.app.workbuddy.host' ? 20 : 4;

  // ---- 云服务初始化（publicConfig，仅含前端安全值）----
  var cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: location.origin,
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_1NOm2SkmmEHnBAIYJLFNUY_CFAUhjm5HhsbG0rdLqH2oYNg0pKSml14'
  });

  // ---- 通用工具 ----
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(t) {
    if (!t) return '未提供';
    var d = new Date(t);
    if (isNaN(d.getTime())) return '未提供';
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function showMsg(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg ' + (type || '');
    el.style.display = text ? 'block' : 'none';
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // ---- 积分业务常量（服务端同样固定这些数值，前端只用于展示与提示）----
  var POINTS = {
    SIGNUP_BONUS: 50,   // 注册奖励
    LEGACY_GRANT: 50,   // 存量用户一次性初始化奖励
    DAILY_CHECKIN: 5,   // 每日签到
    BOUNTY: 5           // 每次求助的固定悬赏
  };

  var POINT_TYPE_MAP = {
    signup_bonus: { text: '注册奖励', cls: 'pt-gain' },
    legacy_initial_grant: { text: '存量用户初始化奖励', cls: 'pt-gain' },
    daily_checkin: { text: '签到奖励', cls: 'pt-gain' },
    bounty_lock: { text: '悬赏预留', cls: 'pt-spend' },
    bounty_reward: { text: '悬赏收入', cls: 'pt-gain' },
    bounty_refund: { text: '悬赏退款', cls: 'pt-gain' }
  };

  // 悬赏状态（求助维度）
  var BOUNTY_STATUS_MAP = {
    none: { text: '历史求助 · 无悬赏', cls: 'st-closed' },
    locked: { text: '悬赏已预留 · 待支付', cls: 'st-pending' },
    paid: { text: '悬赏已支付', cls: 'st-resolved' },
    refunded: { text: '悬赏已退还', cls: 'st-closed' }
  };

  function pointTypeBadge(type) {
    var s = POINT_TYPE_MAP[type] || { text: type || '其他', cls: '' };
    return '<span class="badge ' + s.cls + '">' + escapeHtml(s.text) + '</span>';
  }

  // 悬赏状态徽章：历史数据（bounty_status='none'）显示真实状态，不伪造悬赏记录
  function bountyBadge(req) {
    var st = (req && req.bounty_status) || 'none';
    var s = BOUNTY_STATUS_MAP[st] || BOUNTY_STATUS_MAP.none;
    var txt = s.text;
    if (st !== 'none' && req && req.bounty_points) {
      txt += '（' + req.bounty_points + ' 积分）';
    }
    return '<span class="badge ' + s.cls + '">' + escapeHtml(txt) + '</span>';
  }

  function signedAmount(amount) {
    return (amount > 0 ? '+' : '') + amount;
  }

  // 求助状态机（存储值 → 展示）。open 等价于需求中的 seeking（求助中），
  // 历史数据继续用 open，不做破坏性重写；新增待审核 / 待复核 / 无效三个真实状态。
  var STATUS_MAP = {
    seeking: { text: '求助中', cls: 'st-open' },
    open: { text: '求助中', cls: 'st-open' },
    in_progress: { text: '互助中', cls: 'st-progress' },
    pending_requester_review: { text: '待求助人审核', cls: 'st-pending' },
    pending_admin_review: { text: '待管理员复核', cls: 'st-review' },
    resolved: { text: '已解决', cls: 'st-resolved' },
    completed: { text: '已完成', cls: 'st-resolved' },
    closed: { text: '已关闭', cls: 'st-closed' },
    invalid: { text: '已失效', cls: 'st-closed' }
  };
  var ATT_STATUS_MAP = {
    pending: { text: '待审核', cls: 'st-pending' },
    approved: { text: '审核通过', cls: 'st-resolved' },
    rejected: { text: '审核不通过（旧）', cls: 'st-closed' },
    rejected_by_requester: { text: '求助人初审不通过 · 待复核', cls: 'st-review' },
    rejected_by_admin: { text: '管理员判定不符合要求', cls: 'st-closed' },
    closed: { text: '未采纳', cls: 'st-closed' },
    expired: { text: '已过期清理', cls: 'st-closed' }
  };

  // 求助是否已过 48 小时文件保留期（历史 completed 记录无 file_expires_at 时按 completed_at + 48h 推算）
  function isFileExpired(req) {
    if (!req || req.status !== 'completed') return false;
    if (req.file_cleanup_status === 'done') return true;
    var t = req.file_expires_at;
    if (!t && req.completed_at) {
      t = new Date(new Date(req.completed_at).getTime() + 48 * 3600 * 1000).toISOString();
    }
    if (!t) return false;
    return new Date(t).getTime() <= Date.now();
  }

  // 剩余可下载时间文案（用于详情页提示）
  function fileExpiryText(req) {
    if (!req) return '';
    if (isFileExpired(req)) return '文件已过期清理';
    var t = req.file_expires_at;
    if (!t && req.completed_at) {
      t = new Date(new Date(req.completed_at).getTime() + 48 * 3600 * 1000).toISOString();
    }
    if (!t) return '';
    var left = new Date(t).getTime() - Date.now();
    if (left <= 0) return '文件已过期清理';
    var h = Math.floor(left / 3600000);
    var m = Math.floor((left % 3600000) / 60000);
    return '文件保留至 ' + fmtTime(t) + '（剩余约 ' + h + ' 小时 ' + m + ' 分）';
  }
  function statusBadge(status) {
    var s = STATUS_MAP[status] || { text: status || '未知', cls: '' };
    return '<span class="badge ' + s.cls + '">' + escapeHtml(s.text) + '</span>';
  }
  function attStatusBadge(status) {
    var s = ATT_STATUS_MAP[status] || { text: status || '未知', cls: '' };
    return '<span class="badge ' + s.cls + '">' + escapeHtml(s.text) + '</span>';
  }

  // ---- DOI 规范化与文献元数据解析 ----
  // 纯逻辑（规范化、各来源字段映射、多来源编排）与 server.js 共享 assets/doi-core.js，
  // 保证浏览器与服务器两端行为完全一致。使用 DOI 功能的页面需在 app.js 之前引入 doi-core.js。
  var CORE = (typeof window !== 'undefined' && window.DOI_CORE) ||
    (typeof DOI_CORE !== 'undefined' ? DOI_CORE : null);
  if (!CORE) {
    // 兜底：理论上不会走到（页面均已引入 doi-core.js），给出明确错误而非静默失败
    CORE = {
      normalizeDoi: function () { throw new Error('doi-core.js 未加载'); },
      lookupPaperMetadata: function () { return Promise.reject(new Error('doi-core.js 未加载')); }
    };
  }
  var normalizeDoi = CORE.normalizeDoi;
  var lookupPaperMetadata = CORE.lookupPaperMetadata;

  function doiError(kind, message, extra) {
    var e = new Error(message);
    e.kind = kind;
    if (extra) { for (var k in extra) e[k] = extra[k]; }
    return e;
  }

  // 浏览器直连外部来源时的 HTTP 封装（仅在同源 API 不可用的静态预览环境兜底使用；
  // 正式环境由 server.js 的服务端代为请求，浏览器不直连外部文献服务）。
  // 失败类型严格区分：not_found（来源确认无记录）/ timeout / http / network，绝不伪造数据。
  function browserHttpGet(url, accept, timeoutMs) {
    var started = Date.now();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 12000);
    return fetch(url, { signal: controller.signal, headers: { 'Accept': accept } })
      .then(function (res) {
        clearTimeout(timer);
        var ms = Date.now() - started;
        if (res.status === 404) throw doiError('not_found', 'HTTP 404', { httpStatus: 404, elapsedMs: ms });
        if (!res.ok) throw doiError('http', 'HTTP ' + res.status, { httpStatus: res.status, elapsedMs: ms });
        return res.json().then(function (j) { return { json: j, httpStatus: res.status, elapsedMs: ms }; });
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.kind) throw err;
        if (err && err.name === 'AbortError') {
          throw doiError('timeout', '请求超时（' + Math.round((timeoutMs || 12000) / 1000) + ' 秒）', { elapsedMs: Date.now() - started });
        }
        throw doiError('network', '网络请求失败：' + (err && err.message ? err.message : '未知错误'), { elapsedMs: Date.now() - started });
      });
  }

  // 各外部来源的字段映射解析器已移至 assets/doi-core.js（与 server.js 共享），此处引用
  var parseCrossrefMessage = CORE.parseCrossrefMessage;

  // 静态预览环境（没有本站服务端接口）时的直连兜底。若直连被 CSP / 网络拦截，
  // 抛出明确提示，避免把“环境不支持”误报成“文献服务或 DOI 有问题”。
  function directLookupFallback(doi) {
    return lookupPaperMetadata(doi, browserHttpGet).catch(function (err) {
      var atts = (err && err.attempts) || [];
      var tried = atts.filter(function (a) { return a.source !== 'doi.org/ra'; });
      var allNetwork = tried.length > 0 && tried.every(function (a) {
        return a.result === 'network' || a.result === 'timeout';
      });
      if (err && err.kind === 'unavailable' && allNetwork) {
        throw doiError('blocked',
          '在线 DOI 查询服务暂时无法访问（本地预览环境无服务端接口，且浏览器直连外部文献服务被安全策略拦截）。' +
          '请改用「没有 DOI？手动填写论文信息」，或通过线上地址打开本站后再查询。',
          { attempts: atts });
      }
      throw err;
    });
  }

  // 线上已部署的同源接口地址：静态预览页没有 /api 路由，但该域名在平台 CSP
  // connect-src 白名单内（与云数据库同一域名），因此预览页可直接复用线上接口。
  var LIVE_API_ORIGIN = 'https://research-aid.app.workbuddy.host';

  // 调用 /api/paper-meta：返回 { ok:true, status, body } 或 { ok:false, status }
  function callMetaApi(doi, origin) {
    var url = (origin || '') + '/api/paper-meta?doi=' + encodeURIComponent(doi);
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (res) {
      var ct = res.headers.get('Content-Type') || '';
      if (ct.indexOf('application/json') === -1) return { ok: false, status: res.status };
      return res.json().then(function (j) { return { ok: true, status: res.status, body: j }; });
    }, function () { return { ok: false, status: 0 }; });
  }

  function handleMetaApiResult(r, doi) {
    if (r.ok && r.body && r.body.found && r.body.paper) {
      console.debug('[论文查询] 接口命中 DOI=' + doi, '来源=' + r.body.source, '过程=', r.body.attempts);
      return { paper: r.body.paper, source: r.body.source, partial: !!r.body.partial, attempts: r.body.attempts || [] };
    }
    var err = (r.body && r.body.error) || {};
    console.debug('[论文查询] 接口未命中 DOI=' + doi, 'kind=' + (err.kind || r.status), '过程=', r.body && r.body.attempts);
    throw doiError(err.kind || (r.status === 404 ? 'not_found' : 'unavailable'),
      err.message || '文献元数据服务返回异常（HTTP ' + r.status + '）',
      { attempts: (r.body && r.body.attempts) || [] });
  }

  // 文献元数据多来源查询：优先本站同源接口 /api/paper-meta（由 server.js 在服务端
  // 请求 Crossref / DataCite / OpenAlex / doi.org，浏览器不直连外部服务）。
  // 本地静态预览没有该路由时，自动改用线上已部署的同一接口；
  // 两者都不可用才回退浏览器直连（最后兜底）。失败语义与服务端一致：
  // not_found（确实无记录）/ unavailable（暂时不可用），绝不伪造数据。
  function fetchPaperMetadata(doi) {
    return callMetaApi(doi).then(function (r) {
      if (r.ok) return handleMetaApiResult(r, doi);   // 本站接口可用：以其结果为准
      return callMetaApi(doi, LIVE_API_ORIGIN).then(function (r2) {
        if (r2.ok) return handleMetaApiResult(r2, doi);
        return directLookupFallback(doi);
      });
    });
  }

  // 兼容旧调用：仅 Crossref 单源（新代码请用 fetchPaperMetadata 走同源接口）
  function fetchCrossref(doi) {
    return browserHttpGet('https://api.crossref.org/works/' + encodeURIComponent(doi), 'application/json', 12000)
      .then(function (res) {
        var paper = parseCrossrefMessage(res.json && res.json.message);
        if (!paper) throw doiError('empty', 'Crossref 返回数据为空，未获取到论文信息。');
        return paper;
      });
  }

  // ---- 数据库：论文去重保存 ----
  function findPaperByDoi(doi) {
    return cloud.database.from('papers').select('*').eq('doi', doi).maybeSingle()
      .then(function (r) {
        if (r.error) throw new Error('查询论文库失败：' + r.error.message);
        return r.data || null;
      });
  }

  function findPaperById(id) {
    return cloud.database.from('papers').select('*').eq('id', id).maybeSingle()
      .then(function (r) {
        if (r.error) throw new Error('查询论文库失败：' + r.error.message);
        return r.data || null;
      });
  }

  // 本地优先检索：先查论文库（papers），未命中再借用历史求助（help_requests）中的元数据快照。
  // 不做任何用户维度过滤（RLS 决定可读范围），全库按规范化 DOI 精确匹配。
  function findLocalPaper(doi) {
    return findPaperByDoi(doi).then(function (p) {
      if (p) return { paper: p, source: 'papers' };
      return cloud.database.from('help_requests').select('*').eq('doi', doi)
        .order('created_at', { ascending: false }).limit(1)
        .then(function (r) {
          if (r.error) throw new Error('查询历史求助失败：' + r.error.message);
          var row = r.data && r.data[0];
          if (!row) return null;
          return {
            paper: {
              doi: row.doi, title: row.paper_title, authors: row.authors, journal: row.journal,
              journal_type: row.journal_type, published_year: row.published_year, volume: row.volume,
              issue: row.issue, pages: row.pages, publisher: row.publisher, source_url: row.source_url,
              issn: null, doi_url: row.doi ? 'https://doi.org/' + row.doi : null
            },
            source: 'help_requests'
          };
        });
    });
  }

  // 标题归一化：去标点、空格、大小写，用于无 DOI 时的查重比较
  function normalizeTitleKey(s) {
    if (!s) return '';
    return String(s).toLowerCase()
      .replace(/[\s　]+/g, '')
      .replace(/[.,;:!?()\[\]{}"'“”‘’\/\\|<>《》【】·\-_—～~]+/g, '')
      .trim();
  }

  // 无 DOI 时按下标题 + 年份匹配已入库论文，避免重复创建论文记录
  function findPaperByTitle(title, year) {
    var key = normalizeTitleKey(title);
    if (!key) return Promise.resolve(null);
    return cloud.database.from('papers').select('*')
      .order('created_at', { ascending: false }).limit(500)
      .then(function (r) {
        if (r.error) throw new Error('查询论文库失败：' + r.error.message);
        var rows = r.data || [];
        for (var i = 0; i < rows.length; i++) {
          if (normalizeTitleKey(rows[i].title) === key) {
            if (!year || !rows[i].published_year || String(rows[i].published_year) === String(year)) return rows[i];
          }
        }
        return null;
      });
  }

  // 保存论文元数据：有 DOI 按 DOI 去重，无 DOI 按标题+年份去重；不生成虚假 DOI
  function savePaper(meta) {
    var payload = {
      doi: meta.doi || null,
      title: meta.title || null,
      authors: meta.authors || null,
      journal: meta.journal || null,
      journal_type: meta.journal_type || null,
      publisher: meta.publisher || null,
      published_year: meta.published_year || null,
      volume: meta.volume || null,
      issue: meta.issue || null,
      pages: meta.pages || null,
      issn: meta.issn || null,
      doi_url: meta.doi_url || null,
      source_url: meta.source_url || null,
      oa_url: meta.oa_url || null,
      license: meta.license || null
    };
    var lookup = payload.doi ? findPaperByDoi(payload.doi) : findPaperByTitle(payload.title, payload.published_year);
    return lookup.then(function (existing) {
      if (existing) return existing; // 已存在则不重复创建
      return cloud.database.from('papers').insert(payload).select().then(function (r) {
        if (r.error) {
          if (String(r.error.code || '').indexOf('23505') >= 0) return findPaperByDoi(payload.doi);
          throw new Error('保存论文信息失败：' + r.error.message);
        }
        return (r.data && r.data[0]) || null;
      });
    });
  }

  // 按 DOI 查历史求助
  function findRequestsByDoi(doi) {
    return cloud.database.from('help_requests').select('*')
      .eq('doi', doi).order('created_at', { ascending: false })
      .then(function (r) {
        if (r.error) throw new Error('查询历史求助失败：' + r.error.message);
        return r.data || [];
      });
  }

  // 查重（兼容无 DOI）：有 DOI 优先按规范化 DOI 精确匹配；
  // 无 DOI 时用标题（归一化）+ 出版年份 + 期刊做相似匹配。
  // 返回 { by:'doi'|'title'|'none', exact:[], possible:[], reliable:bool }
  function findDuplicateRequests(paper) {
    var doi = paper && paper.doi ? paper.doi : null;
    var title = (paper && paper.title) || '';
    var year = (paper && paper.published_year) || null;
    var journal = (paper && paper.journal) || '';

    if (doi) {
      return findRequestsByDoi(doi).then(function (list) {
        return { by: 'doi', exact: list, possible: [], reliable: true };
      });
    }
    var key = normalizeTitleKey(title);
    if (!key) {
      return Promise.resolve({ by: 'none', exact: [], possible: [], reliable: false });
    }
    return cloud.database.from('help_requests')
      .select('id,doi,paper_title,authors,journal,published_year,status,owner_name,created_at')
      .order('created_at', { ascending: false }).limit(500)
      .then(function (r) {
        if (r.error) throw new Error('查重失败：' + r.error.message);
        var rows = r.data || [];
        var exact = [], possible = [];
        rows.forEach(function (it) {
          var k = normalizeTitleKey(it.paper_title);
          if (!k) return;
          if (k === key) { exact.push(it); return; }
          if (k.indexOf(key) >= 0 || key.indexOf(k) >= 0) { possible.push(it); return; }
          // 标题不相似但「期刊 + 年份」一致，也提示为可能重复
          if (year && it.published_year && String(it.published_year) === String(year) &&
            journal && it.journal && normalizeTitleKey(journal) === normalizeTitleKey(it.journal)) {
            possible.push(it);
          }
        });
        return { by: 'title', exact: exact, possible: possible, reliable: true };
      });
  }

  // ---- 会话与权限 ----
  function getSession() {
    return cloud.auth.getSession().then(function (r) {
      if (r.error) return null;
      return r.data || null;
    });
  }

  function requireLogin() {
    return getSession().then(function (session) {
      if (!session) {
        var next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
        location.href = 'login.html?next=' + next;
        return null;
      }
      return session;
    });
  }

  // ---- 用户资料（昵称）----
  // 昵称存于受 RLS 保护的 profiles 表：只能读写自己的记录，角色与用户 ID 由平台身份系统管理
  function getMyProfile(session) {
    if (!session || !session.user || !session.user.id) return Promise.resolve(null);
    return cloud.database.from('profiles').select('*').eq('user_id', session.user.id).maybeSingle()
      .then(function (r) { return (r.data || null); })
      .catch(function () { return null; });
  }

  // 保存昵称：走服务端函数 set_my_nickname（校验长度与字符、强制绑定 auth.uid()、同步历史求助发布者名称）
  function saveNickname(nick) {
    return cloud.database.rpc('set_my_nickname', { nick: nick }).then(function (r) {
      if (r.error) throw new Error(r.error.message || '昵称保存失败');
      return r.data || null;
    });
  }

  // 统一显示名：昵称 > 平台账号名 > 未设置昵称
  function displayName(session, profile) {
    if (profile && profile.nickname) return profile.nickname;
    if (session && session.user && session.user.name) return session.user.name;
    return null;
  }

  // 平台统计：走服务端函数 platform_stats（真实查询，不依赖浏览器读不到的 Content-Range 头）
  function platformStats() {
    return cloud.database.rpc('platform_stats').then(function (r) {
      if (r.error) throw new Error(r.error.message || '统计查询失败');
      var d = r.data || {};
      return {
        papers: d.papers || 0,
        requests: d.requests || 0,
        open: d.open_count || 0,
        resolved: d.resolved_count || 0
      };
    });
  }

  // ---- 积分：全部余额变动都走服务端函数（SECURITY DEFINER），前端只负责展示 ----
  // 客户端无法直接写 point_accounts / point_transactions：
  //   1) 两张表只授予 SELECT，INSERT/UPDATE/DELETE/TRUNCATE 已回收
  //   2) 表上只有「本人或管理员可读」的 SELECT 策略，没有任何写策略
  //   3) point_grant 记账函数的 EXECUTE 已从 anon / authenticated 回收，只能被服务端函数调用
  function rpc(name, params) {
    return cloud.database.rpc(name, params || {}).then(function (r) {
      if (r.error) throw new Error(r.error.message || ('调用 ' + name + ' 失败'));
      return r.data || {};
    });
  }

  // 幂等：确保积分账户存在，并在首次使用时发放一次注册奖励（已有注册/存量奖励则不再发放）
  function ensureMyPoints() {
    return rpc('ensure_my_points');
  }

  // 每日签到：服务端按 Asia/Shanghai 自然日判断，唯一业务键保证同一天只发一次
  function dailyCheckin() {
    return rpc('daily_checkin');
  }

  function myPointsOverview() {
    return rpc('my_points_overview');
  }

  // 本人积分明细（RLS 保证只能读到自己的记录）
  function myTransactions(limit) {
    // id 为自增序列，倒序等价于按时间倒序，且不受同一秒多条记录的影响
    return cloud.database.from('point_transactions').select('*')
      .order('id', { ascending: false })
      .limit(limit || 20)
      .then(function (r) {
        if (r.error) throw new Error('积分明细加载失败：' + r.error.message);
        return r.data || [];
      });
  }

  // 每日助人排行榜：只统计今天审核通过的悬赏收入，注册 / 存量 / 签到 / 退款均不计入
  function dailyLeaderboard(limit) {
    return rpc('daily_helper_leaderboard', { p_limit: limit || 10 });
  }

  // 发布求助：悬赏金额由服务端固定为 5，前端不传金额；积分不足或记账失败时整笔事务回滚
  function createRequestWithBounty(p) {
    return rpc('create_request_with_bounty', {
      p_paper_id: p.paper_id || null,
      p_doi: p.doi || null,
      p_paper_title: p.paper_title || null,
      p_authors: p.authors || null,
      p_journal: p.journal || null,
      p_journal_type: p.journal_type || null,
      p_published_year: p.published_year || null,
      p_volume: p.volume || null,
      p_issue: p.issue || null,
      p_pages: p.pages || null,
      p_publisher: p.publisher || null,
      p_source_url: p.source_url || null,
      p_description: p.description || null,
      p_owner_name: p.owner_name || null
    });
  }

  // 修改求助状态：关闭 / 取消时服务端退还预留悬赏（唯一业务键保证只退一次）
  function setRequestStatus(requestId, status) {
    return rpc('set_request_status', { p_request_id: requestId, p_status: status });
  }

  // 删除求助：如悬赏仍为已预留则先退还再删除
  function deleteRequestWithRefund(requestId) {
    return rpc('delete_my_request_with_refund', { p_request_id: requestId });
  }

  // ---- 附件生命周期：上传锁定 / 求助人审核 / 管理员复核 / 过期清理 ----
  // 上传：服务端在一个事务内校验登录态、封禁、求助状态、是否已有待审附件，
  // 成功后立即把求助置为 pending_requester_review（乐观锁 FOR UPDATE + 部分唯一索引防并发）。
  function uploadAttachment(p) {
    return rpc('upload_attachment', {
      p_request_id: p.request_id,
      p_file_name: p.file_name,
      p_file_path: p.file_path,
      p_size_bytes: p.size_bytes,
      p_owner_name: p.owner_name || null,
      p_oa_source_url: p.oa_source_url || null,
      p_license_type: p.license_type || null,
      p_license_note: p.license_note || null
    });
  }

  // 求助人审核：approve=完成并支付悬赏；reject=转管理员复核（不退款不发奖）
  function requesterReview(attId, action, note) {
    return rpc('review_attachment', {
      att_id: attId,
      action: action,
      note: note || '',
      reviewer_name: null
    });
  }

  // 管理员最终复核：conform=完成并支付；nonconform=关闭+退款+违规计数（满 3 次封禁 3 天）
  function adminReview(attId, resolution, note) {
    return rpc('admin_review_attachment', {
      att_id: attId,
      resolution: resolution,
      note: note,
      reviewer_name: null
    });
  }

  // 到期清理（幂等）：把到期附件标记为 expired，返回本次处理的附件 ID。
  // 云存储对象的物理删除必须由具备该文件权限的登录用户发起（平台无服务端密钥），
  // 见 removeExpiredFilesAsOwner。
  function cleanupExpiredFiles() {
    return rpc('cleanup_expired_files');
  }

  // 上报云存储删除结果（失败原因入库，供后续重试；不误报为已删除）
  function recordFileDeleteResult(attId, ok, error) {
    return rpc('record_file_delete_result', {
      p_attachment_id: attId,
      p_ok: !!ok,
      p_error: ok ? null : String(error || '未知错误')
    });
  }

  // ---- 互助广场：服务端过滤（仅「求助中且无待审核附件」），分页与总数同一规则 ----
  function squareList(keyword, limit, offset) {
    return rpc('square_list', {
      p_kw: keyword || null,
      p_limit: limit || 10,
      p_offset: offset || 0
    });
  }

  // ---- 邮箱 / 手机号绑定 ----
  // 分工（重要）：
  //  * 验证码由 WorkBuddy 托管认证服务真实下发与校验（服务端接口 /api/link/send、/api/link/confirm），
  //    前端既看不到也生成不了验证码，无法通过改参数绕过验证。
  //  * 校验通过后，由服务端用私有凭据把该邮箱/手机号写入当前登录用户的身份记录
  //    （auth.users.email / phone_number），因此绑定后可用该标识登录同一个账号，不会产生第二个账号。
  //  * 本站资料表 profiles 只保存同样的值与"已验证"标记，用于界面展示与提醒。

  // 1) 登录/注册后把平台会话里已验证的邮箱同步到本站资料（邮箱取自 JWT 声明，
  //    不接受前端任意传值，避免把别人的邮箱绑到自己账号上）。
  function syncSessionEmail() {
    return rpc('sync_session_email', {});
  }

  // 2) 未绑定邮箱时创建一条「请绑定邮箱」站内通知（同一未读通知不重复创建）
  function ensureEmailBindNotice() {
    return rpc('ensure_email_bind_notice', {});
  }

  // 3) 绑定状态：由服务端函数读认证库真实值（邮箱、手机号、是否设过密码、可用登录方式）
  function myLoginState() {
    return rpc('my_login_state', {});
  }

  // 4) 同源接口调用（带当前登录用户的 access token；未登录时为匿名请求）
  function apiPost(pathname, body) {
    function doPost(token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch(pathname, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) })
        .then(function (res) {
          return res.text().then(function (text) {
            var json = null;
            try { json = JSON.parse(text); } catch (e) { json = null; }
            if (res.ok) return json || {};
            var e = new Error((json && json.error && json.error.message) || ('请求失败（HTTP ' + res.status + '）'));
            e.status = res.status;
            e.kind = json && json.error && json.error.kind;
            throw e;
          });
        });
    }
    if (cloud.auth && typeof cloud.auth.getAccessToken === 'function') {
      return cloud.auth.getAccessToken().then(function (t) { return doPost(t || ''); },
        function () { return doPost(''); });
    }
    return doPost('');
  }

  // 5) 请求真实下发验证码（kind: 'phone' 短信 / 'email' 邮件）
  function linkSend(kind, value) {
    return apiPost('/api/link/send', { kind: kind, value: value });
  }

  // 6) 校验验证码并完成绑定（服务端再次校验 + 写身份记录）
  function linkConfirm(kind, value, verificationId, code) {
    return apiPost('/api/link/confirm', {
      kind: kind, value: value, verificationId: verificationId, code: code
    });
  }

  // ---- 可复用的绑定表单交互（登录页与个人中心共用）----
  // ids: { value, code, send, save, step2, tip }
  // opts.kind: 'email' | 'phone'；opts.validate(v) 自定义校验；opts.onSend/opts.onDone 回调
  function bindForm(ids, opts) {
    opts = opts || {};
    var kind = opts.kind === 'phone' ? 'phone' : 'email';
    var el = function (k) { return document.getElementById(ids[k]); };
    var setTip = function (t) { var e = el('tip'); if (e) e.textContent = t; };
    var label = kind === 'phone' ? '短信验证码' : '邮箱验证码';
    var sentTo = '';       // 已请求验证码的标识（防止换号码后复用旧验证码）
    var verificationId = '';
    var countdown = function (btn, text) {
      var n = 60;
      btn.disabled = true;
      var t = setInterval(function () {
        btn.textContent = n + ' 秒后重发';
        if (--n < 0) { clearInterval(t); btn.disabled = false; btn.textContent = text; }
      }, 1000);
    };
    var check = opts.validate || function (v) {
      if (kind === 'phone') return /^1\d{10}$/.test(v.replace(/[^0-9]/g, '').replace(/^86/, '')) ? '' : '请输入正确的 11 位手机号。';
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : '请输入正确的邮箱地址。';
    };

    var sendBtn = el('send');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        var value = (el('value').value || '').trim();
        var bad = check(value);
        if (bad) { setTip(bad); return; }
        var b = this;
        b.disabled = true;
        setTip('正在请求下发' + label + '…');
        linkSend(kind, value).then(function (r) {
          if (r && r.alreadyLinked) {
            b.disabled = false;
            setTip('该' + (kind === 'phone' ? '手机号' : '邮箱') + '已绑定到当前账号，无需重复绑定。');
            if (opts.onDone) opts.onDone(r.value);
            return;
          }
          if (!r || !r.verificationId) {
            b.disabled = false;
            setTip('验证码下发失败：认证服务未返回有效凭据，请稍后重试。');
            return;
          }
          sentTo = value; verificationId = r.verificationId;
          if (el('step2')) el('step2').classList.remove('hidden');
          setTip(label + '已发送，请查收（5 分钟内有效，仅可使用一次）。');
          countdown(b, '重新发送');
          if (opts.onSend) opts.onSend(value);
        }, function (err) {
          b.disabled = false;
          setTip('发送失败：' + (err.message || '未知错误'));
          if (opts.onFail) opts.onFail(err);
        });
      });
    }

    var saveBtn = el('save');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var value = (el('value').value || '').trim();
        var code = (el('code').value || '').trim();
        if (!verificationId || sentTo !== value) { setTip('请先为当前' + (kind === 'phone' ? '手机号' : '邮箱') + '获取验证码。'); return; }
        if (!/^\d{4,8}$/.test(code)) { setTip('请输入收到的验证码。'); return; }
        var b = this;
        b.disabled = true;
        setTip('正在校验…');
        linkConfirm(kind, value, verificationId, code).then(function (r) {
          b.disabled = false;
          verificationId = '';
          setTip('绑定成功。');
          if (opts.onDone) opts.onDone((r && r.state && (r.state.phone || r.state.email)) || value, r && r.state);
        }, function (err) {
          b.disabled = false;
          setTip('绑定失败：' + (err.message || '验证码错误或已过期'));
          if (opts.onFail) opts.onFail(err);
        });
      });
    }
  }

  // 邮箱绑定表单（保持原有调用方式，内部改走平台真实校验）
  function emailBindForm(ids, opts) {
    var mapped = { value: ids.email, code: ids.code, send: ids.send, save: ids.save, step2: ids.step2, tip: ids.tip };
    return bindForm(mapped, Object.assign({ kind: 'email' }, opts || {}));
  }

  // 手机号绑定表单
  function phoneBindForm(ids, opts) {
    var mapped = { value: ids.phone, code: ids.code, send: ids.send, save: ids.save, step2: ids.step2, tip: ids.tip };
    return bindForm(mapped, Object.assign({ kind: 'phone' }, opts || {}));
  }


  // ---- 院校期刊订阅目录 ----
  // 正式目录、用户提交、审核记录、推荐批次全部只经服务端函数访问：
  //   相关表对 anon / authenticated 已 REVOKE ALL 且开启 RLS，前端无法直接写入或改动审核状态。
  var SUB_STATUS_LABEL = {
    pending: '待管理员审核',
    approved: '审核通过',
    rejected: '审核不通过',
    need_info: '需要补充材料',
    withdrawn: '已撤回'
  };
  var SUB_STATUS_CLASS = {
    pending: 'st-pending',
    approved: 'st-open',
    rejected: 'st-closed',
    need_info: 'st-review',
    withdrawn: 'st-closed'
  };
  var VERIFY_LABEL = {
    verified: '已核验订阅',
    database_only: '仅确认订购数据库（具体期刊待核实）',
    pending: '待核实',
    revoked: '已撤销'
  };
  // 推荐原因只使用这三种确定性表述，未核验的订阅关系不会产生「本校已订阅」文案
  var RECO_TYPE_LABEL = {
    journal: '匹配本校已核验订阅期刊',
    major: '与你的研究方向相关',
    other: '其他相关求助'
  };

  function subStatusText(s) { return SUB_STATUS_LABEL[s] || s || '未知'; }
  function subStatusClass(s) { return SUB_STATUS_CLASS[s] || 'st-pending'; }
  function verifyText(s) { return VERIFY_LABEL[s] || s || '待核实'; }

  function myJournalCatalog(kw) {
    return rpc('my_journal_catalog', { p_kw: kw || null, p_limit: 200 });
  }
  function myJournalSubmissions(limit) {
    return rpc('my_journal_submissions', { p_limit: limit || 50 });
  }
  function submitJournalSubscription(p) {
    p = p || {};
    return rpc('submit_journal_subscription', {
      p_journal_title: p.journal_title || null,
      p_issn: p.issn || null,
      p_eissn: p.eissn || null,
      p_publisher: p.publisher || null,
      p_subject: p.subject || null,
      p_database_name: p.database_name || null,
      p_coverage_years: p.coverage_years || null,
      p_coverage_scope: p.coverage_scope || null,
      p_library_url: p.library_url || null,
      p_evidence_note: p.evidence_note || null,
      p_remark: p.remark || null
    });
  }
  function updateJournalSubmission(p) {
    p = p || {};
    return rpc('update_journal_submission', {
      p_id: p.id,
      p_journal_title: p.journal_title || null,
      p_issn: p.issn || null,
      p_eissn: p.eissn || null,
      p_publisher: p.publisher || null,
      p_subject: p.subject || null,
      p_database_name: p.database_name || null,
      p_coverage_years: p.coverage_years || null,
      p_coverage_scope: p.coverage_scope || null,
      p_library_url: p.library_url || null,
      p_evidence_note: p.evidence_note || null,
      p_remark: p.remark || null
    });
  }
  function withdrawJournalSubmission(id) {
    return rpc('withdraw_journal_submission', { p_id: id });
  }

  // ---- 每日推荐设置与今日推荐 ----
  function myRecommendSetting() {
    return rpc('my_recommend_setting');
  }
  function setMyRecommendSetting(enabled, subjects) {
    return rpc('set_my_recommend_setting', {
      p_enabled: !!enabled,
      p_subjects: subjects || null
    });
  }
  // 幂等：同一天重复调用返回同一批次，不会重复生成或重复发通知
  function myTodayRecommendations() {
    return rpc('my_today_recommendations');
  }

  // ---- 管理员：期刊订阅审核 ----
  function adminListJournalSubmissions(status) {
    return rpc('admin_list_journal_submissions', { p_status: status || null, p_limit: 200 });
  }
  function adminReviewJournalSubmission(p) {
    p = p || {};
    return rpc('admin_review_journal_submission', {
      p_id: p.id,
      p_action: p.action,
      p_note: p.note || null,
      p_verify_level: p.verify_level || 'journal',
      p_coverage_years: p.coverage_years || null,
      p_coverage_scope: p.coverage_scope || null,
      p_database_name: p.database_name || null,
      p_source_url: p.source_url || null
    });
  }
  function adminListSubscriptions(universityId, kw, status) {
    return rpc('admin_list_subscriptions', {
      p_university_id: universityId || null,
      p_kw: kw || null,
      p_status: status || null,
      p_limit: 500
    });
  }
  function adminUpsertSubscription(p) {
    p = p || {};
    return rpc('admin_upsert_subscription', {
      p_university_id: p.university_id,
      p_journal_title: p.journal_title,
      p_journal_id: p.journal_id || null,
      p_status: p.status || 'pending',
      p_issn: p.issn || null,
      p_eissn: p.eissn || null,
      p_publisher: p.publisher || null,
      p_subject: p.subject || null,
      p_database_name: p.database_name || null,
      p_coverage_years: p.coverage_years || null,
      p_coverage_scope: p.coverage_scope || null,
      p_source_url: p.source_url || null,
      p_evidence_note: p.evidence_note || null,
      p_is_demo: !!p.is_demo
    });
  }
  function adminRevokeSubscription(id, note) {
    return rpc('admin_revoke_subscription', { p_id: id, p_note: note || null });
  }
  function adminMergeJournals(fromId, toId, note) {
    return rpc('admin_merge_journals', {
      p_from_journal_id: fromId,
      p_to_journal_id: toId,
      p_note: note || null
    });
  }
  function adminListJournals(kw) {
    return rpc('admin_list_journals', { p_kw: kw || null, p_limit: 300 });
  }
  function adminJournalLogs(limit) {
    return rpc('admin_journal_logs', { p_limit: limit || 100 });
  }

  // ---- 我发布的求助：服务端分组排序（待审核 → 求助中 → 已完成 → 其他），组内按更新时间倒序 ----
  function myRequestsSorted(limit, offset) {
    return rpc('my_requests_sorted', {
      p_limit: limit || 10,
      p_offset: offset || 0
    });
  }

  // ---- 院校信息 ----
  function searchUniversities(keyword, country, limit) {
    return rpc('search_universities', {
      p_kw: keyword || null,
      p_country: country || null,
      p_limit: limit || 20
    });
  }

  // 保存院校：传 university_id 表示选择正式院校；不传则按自定义院校（标记待核实）
  function setMyUniversity(p) {
    return rpc('set_my_university', {
      p_university_id: p.university_id || null,
      p_name: p.name || null,
      p_country: p.country || null,
      p_type: p.type || null,
      p_college: p.college || null,
      p_major: p.major || null,
      p_visibility: p.visibility || 'private'
    });
  }

  function myUniversity() {
    return rpc('my_university');
  }

  // 标记当前账号已设置密码（仅用于提示「是否设置密码」，不存储密码本身）
  function markPasswordSet() {
    return rpc('mark_password_set');
  }

  // 由文件属主身份删除已过期文件对象（平台云存储不允许匿名/服务端删除）。
  // 删除失败会写入 file_delete_error 与重试次数，下一次调用会继续重试（幂等）。
  function removeExpiredFilesAsOwner() {
    return getSession().then(function (session) {
      if (!session) return { removed: 0, failed: 0 };
      return cloud.database.from('attachments')
        .select('id,file_name,status,request_id,attachment_files(file_path)')
        .eq('owner_id', session.user.id)
        .eq('status', 'expired')
        .limit(50)
        .then(function (r) {
          var rows = (r.data || []).filter(function (a) { return a.attachment_files && a.attachment_files.file_path; });
          if (!rows.length) return { removed: 0, failed: 0 };
          var okPaths = [], okIds = [];
          return Promise.all(rows.map(function (a) {
            var p = a.attachment_files.file_path;
            return cloud.storage.remove([p]).then(function () {
              okPaths.push(p); okIds.push(a.id);
              return recordFileDeleteResult(a.id, true).catch(function () {});
            }, function (err) {
              return recordFileDeleteResult(a.id, false, (err && err.message) || '云存储删除失败').catch(function () {});
            });
          })).then(function () {
            return { removed: okPaths.length, failed: rows.length - okPaths.length };
          });
        });
    }).catch(function () { return { removed: 0, failed: 0 }; });
  }

  function checkAdmin(session) {
    if (!session) return Promise.resolve(false);
    return cloud.database.from('admins').select('user_id').eq('user_id', session.user.id).limit(1)
      .then(function (r) {
        return !!(r.data && r.data.length > 0);
      })
      .catch(function () { return false; });
  }

  // ---- 云存储传输层（临时绕开平台 CORS 缺陷）----
  // 根因：存储数据面的 Access-Control-Allow-Headers 清单未包含 SDK 存储模块自动携带的
  // x-upsert / x-client-info 头，浏览器预检直接失败（表现为 "Failed to fetch"）。
  // 这里仅替换传输层：上传签名与权限校验仍在服务端完成（必须登录），
  // 请求头只用 CORS 允许清单内的 Authorization / x-wb-webapp-access-key / Content-Type。
  // 平台修复 CORS 后应回退到 SDK 的 cloud.storage.upload / createSignedUrl。
  var CLOUD_ENDPOINT = location.origin;
  var PUB_KEY = 'wbpk_1NOm2SkmmEHnBAIYJLFNUY_CFAUhjm5HhsbG0rdLqH2oYNg0pKSml14';

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function storageApi(pathSuffix, body) {
    return cloud.auth.getAccessToken().then(function (token) {
      if (!token) throw new Error('请先登录后再操作文件。');
      return fetch(CLOUD_ENDPOINT + '/.cloud/storage' + pathSuffix, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'x-wb-webapp-access-key': PUB_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body || {})
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* 保留原文 */ }
        if (!res.ok) {
          throw new Error('云存储服务错误（HTTP ' + res.status + '）：' + ((j && j.message) || t.slice(0, 200) || '未知错误'));
        }
        return j || {};
      });
    });
  }

  // 上传文件到 runtime 桶的指定路径（如 shared/<uid>/attachments/xxx.pdf）
  // 流程：1) 带登录态向服务端申请签名上传地址（权限在服务端校验）；
  //       2) 用 PUT + FormData 把文件写到签名地址（凭证在 URL 的 token 参数中，无需其他请求头）。
  // 注意：必须用 PUT —— 该签名地址只接受 PUT，POST 会被网关判为缺少凭证（401 MISSING_CREDENTIALS）。
  function uploadFile(file, path) {
    if (file.size > UPLOAD_LIMIT_MB * 1024 * 1024) {
      return Promise.reject(new Error('当前站点暂支持最大 ' + UPLOAD_LIMIT_MB + 'MB 的附件。'));
    }
    return storageApi('/object/upload/sign/runtime/' + path, {}).then(function (data) {
      if (!data || !data.url) throw new Error('未获得上传凭证，请重新登录后重试。');
      var rel = String(data.url);
      // 兜底：个别环境下 url 可能不带 token，而 token 单独返回
      if (rel.indexOf('token=') < 0 && data.token) {
        rel += (rel.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(data.token);
      }
      var fd = new FormData();
      fd.append('cacheControl', '3600');
      fd.append('', file);
      // 网关在数据面同样要求 x-wb-webapp-access-key 头（在 CORS 允许清单内，不会导致预检失败）；
      // 除此之外不携带其他自定义头
      return fetch(CLOUD_ENDPOINT + '/.cloud/storage' + rel, {
        method: 'PUT',
        headers: { 'x-wb-webapp-access-key': PUB_KEY },
        body: fd
      });
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('文件写入云存储失败（HTTP ' + res.status + '）：' + (t || '').slice(0, 200));
        });
      }
      return true;
    });
  }

  // 获取限时下载地址（服务端在签发时校验读取权限）
  function getSignedDownloadUrl(path, ttlSeconds) {
    return storageApi('/object/sign/runtime/' + encodeURI(path), { expiresIn: ttlSeconds || 600 })
      .then(function (data) {
        if (!data || !data.signedURL) throw new Error('未获得下载地址。');
        return CLOUD_ENDPOINT + '/.cloud/storage' + data.signedURL;
      });
  }

  // 下载文件：网关要求 x-wb-webapp-access-key 头，window.open 无法携带，
  // 因此用 fetch 带头拉取后转为浏览器本地下载
  function downloadFile(path, fileName) {
    return getSignedDownloadUrl(path, 600).then(function (url) {
      return fetch(url, { headers: { 'x-wb-webapp-access-key': PUB_KEY } });
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('下载失败（HTTP ' + res.status + '）：' + (t || '').slice(0, 200));
        });
      }
      return res.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      var objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = fileName || 'attachment.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(objUrl); a.remove(); }, 1000);
      return true;
    });
  }

  // ---- 论文元数据渲染（广场 / 详情 / 发布页共用）----
  // src 可以是 help_requests 行（含快照字段）或 papers 行；缺失字段显示「暂未提供」
  function paperMetaRows(src) {
    src = src || {};
    function row(k, v, hl) {
      return '<div class="field-row' + (hl ? ' hl' : '') + '"><span class="k">' + k + '</span><span class="v">' +
        (v ? v : '<em class="muted">暂未提供</em>') + '</span></div>';
    }
    function link(url) {
      if (!url) return '';
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>';
    }
    var cite = [];
    if (src.journal) cite.push('<strong>' + escapeHtml(src.journal) + '</strong>');
    if (src.published_year) cite.push(escapeHtml(String(src.published_year)) + ' 年');
    if (src.volume) cite.push('卷 ' + escapeHtml(src.volume));
    if (src.issue) cite.push('第 ' + escapeHtml(src.issue) + ' 期');
    if (src.pages) cite.push('页 ' + escapeHtml(src.pages));

    var html = '';
    html += row('论文标题', escapeHtml(src.title || src.paper_title));
    html += row('作者', escapeHtml(src.authors));
    // 期刊名称、出版年份、卷期页码重点突出，便于应助人判断院校是否订阅
    html += row('期刊名称', src.journal ? '<strong>' + escapeHtml(src.journal) + '</strong>' : '', true);
    html += row('期刊类型 / 学科类别', escapeHtml(src.journal_type));
    html += row('出版年份', src.published_year ? '<strong>' + escapeHtml(String(src.published_year)) + '</strong>' : '', true);
    html += row('卷号', escapeHtml(src.volume), true);
    html += row('期号', escapeHtml(src.issue), true);
    html += row('起止页码', escapeHtml(src.pages), true);
    html += row('出版社', escapeHtml(src.publisher));
    html += row('DOI', src.doi ? escapeHtml(src.doi) : '', false);
    html += row('ISSN', escapeHtml(src.issn));
    html += row('论文页面 / 公开来源', link(src.source_url || src.doi_url || src.oa_url));
    if (cite.length) {
      html += row('文献出处', cite.join(' · '), true);
    }
    return html;
  }

  // 合并求助记录与其关联论文：求助快照优先，缺失字段用关联 papers 补齐（兼容历史记录）
  function mergePaperMeta(row) {
    row = row || {};
    var p = row.papers || {};
    function pick(a, b) { return (a === null || a === undefined || a === '') ? b : a; }
    return {
      id: row.id,
      doi: pick(row.doi, p.doi),
      title: pick(row.paper_title, p.title),
      paper_title: row.paper_title,
      authors: pick(row.authors, p.authors),
      journal: pick(row.journal, p.journal),
      journal_type: pick(row.journal_type, p.journal_type),
      published_year: pick(row.published_year, p.published_year),
      volume: pick(row.volume, p.volume),
      issue: pick(row.issue, p.issue),
      pages: pick(row.pages, p.pages),
      publisher: pick(row.publisher, p.publisher),
      issn: pick(row.issn, p.issn),
      source_url: pick(row.source_url, p.source_url || p.doi_url),
      description: row.description,
      status: row.status,
      owner_name: row.owner_name,
      created_at: row.created_at,
      bounty_points: row.bounty_points,
      bounty_status: row.bounty_status || 'none',
      bounty_paid_at: row.bounty_paid_at
    };
  }

  // 广场卡片上的紧凑文献出处（期刊 · 年份 · 卷期页码）
  function paperCiteLine(src) {
    src = src || {};
    var parts = [];
    if (src.journal) parts.push('<strong>' + escapeHtml(src.journal) + '</strong>');
    if (src.published_year) parts.push(escapeHtml(String(src.published_year)) + ' 年');
    if (src.volume) parts.push('卷' + escapeHtml(src.volume));
    if (src.issue) parts.push('第' + escapeHtml(src.issue) + '期');
    if (src.pages) parts.push('页' + escapeHtml(src.pages));
    return parts.join(' · ');
  }

  // ---- 开放获取来源或授权说明区块（始终渲染，缺省显示“未提供”）----
  function renderOaBlock(opts) {
    var oaLink = opts.oa_link || opts.oa_source_url || '';
    var licenseType = opts.license_type || '';
    var licenseNote = opts.license_note || '';
    var shareConfirmed = opts.share_confirmed;
    var rows = '';
    rows += '<div class="oa-row"><span class="oa-label">开放获取来源链接</span><span class="oa-value">' +
      (oaLink ? '<a href="' + escapeHtml(oaLink) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(oaLink) + '</a>' : '<em>未提供</em>') + '</span></div>';
    rows += '<div class="oa-row"><span class="oa-label">许可类型 / 授权依据</span><span class="oa-value">' +
      (licenseType ? escapeHtml(licenseType) : '<em>未提供</em>') + '</span></div>';
    rows += '<div class="oa-row"><span class="oa-label">补充说明</span><span class="oa-value">' +
      (licenseNote ? escapeHtml(licenseNote) : '<em>未提供</em>') + '</span></div>';
    if (shareConfirmed !== undefined) {
      rows += '<div class="oa-row"><span class="oa-label">上传者确认有权分享</span><span class="oa-value">' +
        (shareConfirmed ? '已确认' : '<em>未确认</em>') + '</span></div>';
    }
    return '<div class="oa-block"><h3>开放获取来源或授权说明</h3>' + rows +
      '<p class="oa-tip">提示：学校订阅资源不能默认作为可公开分发的文件，请优先提供合法的开放获取链接和经授权的文件。</p></div>';
  }

  // ================= 期刊数据库（第一期） =================
  // 设计要点：筛选、分页、权限判定全部在服务端函数里完成，前端只传条件。
  // 影响因子与分区按「年份 + 来源」独立成行，接口不提供任何跨年推断。
  function journalSearch(p) {
    p = p || {};
    function num(v) { return (v === '' || v === null || v === undefined) ? null : Number(v); }
    return rpc('journal_search', {
      p_kw: p.kw || null,
      p_subject: p.subject || null,
      p_publisher: p.publisher || null,
      p_if_min: num(p.ifMin),
      p_if_max: num(p.ifMax),
      p_year: num(p.year),
      p_quartile: p.quartile || null,
      p_system: p.system || null,
      p_include_demo: !!p.includeDemo,
      p_limit: p.limit || 20,
      p_offset: p.offset || 0
    });
  }

  function journalDetail(id) {
    return rpc('journal_detail', { p_id: Number(id) });
  }

  function journalFilterOptions() {
    return rpc('journal_filter_options');
  }

  function adminJournalList(kw, limit, offset) {
    return rpc('journal_admin_list', { p_kw: kw || null, p_limit: limit || 20, p_offset: offset || 0 });
  }

  function adminJournalSaveJournal(payload) {
    return rpc('journal_admin_save_journal', { p_payload: payload });
  }

  function adminJournalSaveMetric(payload) {
    return rpc('journal_admin_save_metric', { p_payload: payload });
  }

  function adminJournalSaveQuartile(payload) {
    return rpc('journal_admin_save_quartile', { p_payload: payload });
  }

  function adminJournalDelete(kind, id) {
    return rpc('journal_admin_delete', { p_kind: kind, p_id: Number(id) });
  }

  // CSV 导入：dryRun=true 只做校验与分类，不落库
  function journalImport(type, fileName, rows, dryRun) {
    return rpc('journal_import', {
      p_type: type,
      p_file_name: fileName || '',
      p_rows: rows || [],
      p_dry_run: !!dryRun
    });
  }

  function journalImportLogs(limit) {
    return rpc('journal_import_logs', { p_limit: limit || 20 });
  }

  // ---- CSV 解析 / 生成（RFC4180 子集：引号包裹、双引号转义、CRLF、BOM）----
  function parseCsv(text) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    var rows = [], row = [], cur = '', q = false, i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (q) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        cur += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ',') { row.push(cur); cur = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += c; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return { headers: [], rows: [] };
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      var empty = cells.every(function (x) { return String(x).trim() === ''; });
      if (empty) continue;
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = String(cells[idx] === undefined ? '' : cells[idx]).trim(); });
      out.push(obj);
    }
    return { headers: headers, rows: out };
  }

  function csvEscape(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(headers, rows) {
    var lines = [headers.map(csvEscape).join(',')];
    (rows || []).forEach(function (r) {
      lines.push(headers.map(function (h) { return csvEscape(r[h]); }).join(','));
    });
    return lines.join('\r\n');
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob(['\uFEFF' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ---- 导航 ----
  function renderNav(active, session, isAdmin, profile) {
    var el = document.getElementById('nav');
    if (!el) return;
    var items = [
      ['index.html', '首页', 'home'],
      ['paper.html', '论文查询', 'paper'],
      ['square.html', '互助广场', 'square'],
      ['journals.html', '期刊数据库', 'journals'],
      ['publish.html', '发布求助', 'publish'],
      ['leaderboard.html', '助人排行榜', 'leaderboard'],
      ['profile.html', '个人中心', 'profile']
    ];
    if (isAdmin) items.push(['admin.html', '管理员后台', 'admin']);
    if (isAdmin) items.push(['admin-journals.html', '期刊管理', 'admin-journals']);
    if (isAdmin) items.push(['admin-email.html', '邮件服务', 'admin-email']);
    var html = '<div class="nav-inner"><a class="brand" href="index.html">科研互助平台</a><div class="nav-links">';
    items.forEach(function (it) {
      html += '<a href="' + it[0] + '"' + (it[2] === active ? ' class="active"' : '') + '>' + it[1] + '</a>';
    });
    html += '</div><div class="nav-user">';
    if (session) {
      var name = displayName(session, profile) || '未设置昵称';
      html += '<span class="nav-username">' + escapeHtml(name) + '</span><a href="#" id="nav-logout">退出</a>';
    } else {
      html += '<a href="login.html" class="btn btn-sm">登录 / 注册</a>';
    }
    html += '</div></div>';
    el.innerHTML = html;
    var lo = document.getElementById('nav-logout');
    if (lo) {
      lo.addEventListener('click', function (e) {
        e.preventDefault();
        cloud.auth.signOut().then(function () { location.href = 'index.html'; });
      });
    }
  }

  function initPage(active) {
    return getSession().then(function (session) {
      return Promise.all([checkAdmin(session), getMyProfile(session)]).then(function (rs) {
        renderNav(active, session, rs[0], rs[1]);
        // 登录后幂等初始化积分账户 / 发放注册奖励（已有奖励记录不会重复发放）。
        // 不阻塞页面渲染，失败也不影响其它功能。
        if (session) {
          ensureMyPoints().catch(function () { /* 静默：页面会在需要时再次尝试 */ });
          // 每次登录触发一次到期文件的物理删除重试（幂等；失败原因会记录，下次继续重试）
          removeExpiredFilesAsOwner().catch(function () { /* 静默 */ });
        }
        return { session: session, isAdmin: rs[0], profile: rs[1] };
      });
    });
  }

  window.APP = {
    cloud: cloud,
    escapeHtml: escapeHtml,
    fmtTime: fmtTime,
    showMsg: showMsg,
    qs: qs,
    statusBadge: statusBadge,
    attStatusBadge: attStatusBadge,
    pointTypeBadge: pointTypeBadge,
    bountyBadge: bountyBadge,
    signedAmount: signedAmount,
    POINTS: POINTS,
    POINT_TYPE_MAP: POINT_TYPE_MAP,
    ensureMyPoints: ensureMyPoints,
    dailyCheckin: dailyCheckin,
    myPointsOverview: myPointsOverview,
    myTransactions: myTransactions,
    dailyLeaderboard: dailyLeaderboard,
    createRequestWithBounty: createRequestWithBounty,
    setRequestStatus: setRequestStatus,
    deleteRequestWithRefund: deleteRequestWithRefund,
    uploadAttachment: uploadAttachment,
    requesterReview: requesterReview,
    adminReview: adminReview,
    cleanupExpiredFiles: cleanupExpiredFiles,
    removeExpiredFilesAsOwner: removeExpiredFilesAsOwner,
    recordFileDeleteResult: recordFileDeleteResult,
    squareList: squareList,
    myRequestsSorted: myRequestsSorted,
    syncSessionEmail: syncSessionEmail,
    myLoginState: myLoginState,
    linkSend: linkSend,
    linkConfirm: linkConfirm,
    ensureEmailBindNotice: ensureEmailBindNotice,
    emailBindForm: emailBindForm,
    phoneBindForm: phoneBindForm,
    // 院校期刊订阅 + 每日推荐
    SUB_STATUS_LABEL: SUB_STATUS_LABEL,
    VERIFY_LABEL: VERIFY_LABEL,
    RECO_TYPE_LABEL: RECO_TYPE_LABEL,
    subStatusText: subStatusText,
    subStatusClass: subStatusClass,
    verifyText: verifyText,
    myJournalCatalog: myJournalCatalog,
    myJournalSubmissions: myJournalSubmissions,
    submitJournalSubscription: submitJournalSubscription,
    updateJournalSubmission: updateJournalSubmission,
    withdrawJournalSubmission: withdrawJournalSubmission,
    myRecommendSetting: myRecommendSetting,
    setMyRecommendSetting: setMyRecommendSetting,
    myTodayRecommendations: myTodayRecommendations,
    adminListJournalSubmissions: adminListJournalSubmissions,
    adminReviewJournalSubmission: adminReviewJournalSubmission,
    adminListSubscriptions: adminListSubscriptions,
    adminUpsertSubscription: adminUpsertSubscription,
    adminRevokeSubscription: adminRevokeSubscription,
    adminMergeJournals: adminMergeJournals,
    adminListJournals: adminListJournals,
    adminJournalLogs: adminJournalLogs,
    searchUniversities: searchUniversities,
    setMyUniversity: setMyUniversity,
    myUniversity: myUniversity,
    markPasswordSet: markPasswordSet,
    isFileExpired: isFileExpired,
    fileExpiryText: fileExpiryText,
    normalizeDoi: normalizeDoi,
    fetchCrossref: fetchCrossref,
    fetchPaperMetadata: fetchPaperMetadata,
    findLocalPaper: findLocalPaper,
    findPaperByDoi: findPaperByDoi,
    findPaperById: findPaperById,
    savePaper: savePaper,
    findRequestsByDoi: findRequestsByDoi,
    findDuplicateRequests: findDuplicateRequests,
    normalizeTitleKey: normalizeTitleKey,
    paperMetaRows: paperMetaRows,
    paperCiteLine: paperCiteLine,
    mergePaperMeta: mergePaperMeta,
    getSession: getSession,
    requireLogin: requireLogin,
    checkAdmin: checkAdmin,
    getMyProfile: getMyProfile,
    saveNickname: saveNickname,
    displayName: displayName,
    platformStats: platformStats,
    // 期刊数据库
    journalSearch: journalSearch,
    journalDetail: journalDetail,
    journalFilterOptions: journalFilterOptions,
    adminJournalList: adminJournalList,
    adminJournalSaveJournal: adminJournalSaveJournal,
    adminJournalSaveMetric: adminJournalSaveMetric,
    adminJournalSaveQuartile: adminJournalSaveQuartile,
    adminJournalDelete: adminJournalDelete,
    journalImport: journalImport,
    journalImportLogs: journalImportLogs,
    parseCsv: parseCsv,
    toCsv: toCsv,
    downloadText: downloadText,
    uuid: uuid,
    uploadFile: uploadFile,
    uploadLimitMB: UPLOAD_LIMIT_MB,
    getSignedDownloadUrl: getSignedDownloadUrl,
    downloadFile: downloadFile,
    renderOaBlock: renderOaBlock,
    initPage: initPage
  };
})();
