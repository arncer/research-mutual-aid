/* 科研互助平台 - 同源 HTTP 服务（零依赖 Node.js）
 *
 * 职责：
 *  1. 托管本站静态页面（与原来纯静态部署完全一致）。
 *  2. 提供同源接口 GET /api/paper-meta?doi=... ：
 *     由服务端完成 DOI 规范化、注册机构路由和 Crossref / DataCite / OpenAlex / doi.org
 *     内容协商的多来源查询与字段映射，浏览器不再直连外部文献服务
 *     （部署环境 CSP 的 connect-src 仅允许 'self' 与本站云服务，外部域名会被拦截）。
 *
 * 安全说明：
 *  - 该接口不持有任何密钥，仅访问公开只读文献元数据 API。
 *  - 外部错误被转换为结构化 JSON 错误（kind: invalid / not_found / unavailable）。
 *  - 每个来源设置独立超时，网络错误 / 超时仅有限重试一次。
 *
 * 运行：监听环境变量 PORT，绑定 0.0.0.0（发布沙箱要求）。
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var net = require('net');
var CORE = require('./assets/doi-core.js');
var SENDER = require('./email-sender.js');
var proxyCloud = require('./cloud-proxy.js');

var ROOT = __dirname;
var PORT = parseInt(process.env.PORT, 10) || 3000;

// 本站云数据库 REST 地址（与前端 assets/app.js 使用的同一套公开凭据）。
// 该 key 本身是发布型公开 key，只用于调用服务端函数；真正的写权限由 RLS 与函数内部校验控制。
var PUBLIC_KEY = process.env.WB_PUBLISHABLE_KEY ||
  'wbpk_1NOm2SkmmEHnBAIYJLFNUY_CFAUhjm5HhsbG0rdLqH2oYNg0pKSml14';
var DB_ORIGIN = process.env.WB_DB_ORIGIN || 'https://research-aid.app.workbuddy.host';

// 读取服务端私有配置（点开头文件，静态服务拒绝下发）
function readServerConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.email.config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// 不依赖全局 fetch 的 HTTP GET（低版本 Node 兜底）：手动跟随最多 3 次重定向
function rawHttpGet(url, headers, timeoutMs, redirectsLeft) {
  return new Promise(function (resolve, reject) {
    var lib = url.indexOf('https:') === 0 ? require('https') : require('http');
    var req = lib.request(url, { method: 'GET', headers: headers }, function (res) {
      var code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var next = new URL(res.headers.location, url).toString();
        return resolve(rawHttpGet(next, headers, timeoutMs, redirectsLeft - 1));
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: code, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// 服务端 HTTP GET：与浏览器版错误分类保持一致（not_found / http / timeout / network）
// 优先使用全局 fetch（Node 18+）；缺失时（低版本运行时）退回 rawHttpGet。
function serverHttpGet(url, accept, timeoutMs) {
  var started = Date.now();
  var ms0 = timeoutMs || 12000;
  var headers = {
    'Accept': accept,
    'User-Agent': 'research-mutual-aid/1.0 (research-aid.app.workbuddy.host)'
  };

  function classify(res, body) {
    var ms = Date.now() - started;
    if (res.status === 404) throw CORE.doiError('not_found', 'HTTP 404', { httpStatus: 404, elapsedMs: ms });
    if (!res.ok) throw CORE.doiError('http', 'HTTP ' + res.status, { httpStatus: res.status, elapsedMs: ms });
    return { json: body, httpStatus: res.status, elapsedMs: ms };
  }

  if (typeof fetch === 'function' && !process.env.FORCE_RAW_HTTP) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms0);
    return fetch(url, { signal: controller.signal, redirect: 'follow', headers: headers }).then(function (res) {
      clearTimeout(timer);
      var ms = Date.now() - started;
      // 先按状态码分类，再解析 JSON：部分来源（Crossref / doi.org / OpenAlex）的 404
      // 或错误页返回的是纯文本 / HTML，若先 res.json() 会误判成网络错误。
      if (res.status === 404) throw CORE.doiError('not_found', 'HTTP 404', { httpStatus: 404, elapsedMs: ms });
      if (!res.ok) throw CORE.doiError('http', 'HTTP ' + res.status, { httpStatus: res.status, elapsedMs: ms });
      return res.text().then(function (text) {
        if (accept === 'text/html') {
          return { json: { html: text }, httpStatus: res.status, elapsedMs: Date.now() - started };
        }
        var body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        if (body === null) {
          throw CORE.doiError('http', 'HTTP ' + res.status + '（响应不是 JSON）', { httpStatus: res.status, elapsedMs: ms });
        }
        return { json: body, httpStatus: res.status, elapsedMs: ms };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.kind) throw err;
      if (err && err.name === 'AbortError') {
        throw CORE.doiError('timeout', '请求超时（' + Math.round(ms0 / 1000) + ' 秒）', { elapsedMs: Date.now() - started });
      }
      throw CORE.doiError('network', '网络请求失败：' + (err && err.message ? err.message : '未知错误'), { elapsedMs: Date.now() - started });
    });
  }

  return rawHttpGet(url, headers, ms0, 3).then(function (r) {
    var fake = { status: r.status, ok: r.status >= 200 && r.status < 300 };
    var body;
    try { body = accept === 'text/html' ? { html: r.text } : JSON.parse(r.text); } catch (e) { body = null; }
    if (fake.ok && body === null) {
      throw CORE.doiError('http', 'HTTP ' + r.status + '（响应不是 JSON）', { httpStatus: r.status, elapsedMs: Date.now() - started });
    }
    return classify(fake, body);
  }).catch(function (err) {
    if (err && err.kind) throw err;
    var msg = (err && err.message) || '未知错误';
    if (/timeout/i.test(msg)) {
      throw CORE.doiError('timeout', '请求超时（' + Math.round(ms0 / 1000) + ' 秒）', { elapsedMs: Date.now() - started });
    }
    throw CORE.doiError('network', '网络请求失败：' + msg, { elapsedMs: Date.now() - started });
  });
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 该接口只返回公开文献元数据，无鉴权、无用户数据；允许任意来源调用，
    // 以便本地静态预览页（无服务端）直接复用线上接口。
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, x-wb-user-token, x-email-worker-key',
    'Access-Control-Max-Age': '86400'
  });
  res.end(body);
}

// 文献元数据同源接口。返回结构：
//   命中：200 { found:true, doi, source, partial, paper, attempts }
//   失败：400 invalid / 404 not_found / 503 unavailable，{ found:false, doi, error:{kind,message}, attempts }
function handlePaperMeta(req, res, urlObj) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '仅支持 GET 请求。' } });
    return;
  }
  var doi = CORE.normalizeDoi(urlObj.searchParams.get('doi') || '');
  if (!doi) {
    sendJson(res, 400, {
      found: false,
      error: { kind: 'invalid', message: 'DOI 格式不正确。有效 DOI 形如 10.xxxx/xxxxx。如果没有 DOI，请手动填写论文信息。' }
    });
    return;
  }
  CORE.lookupPaperMetadata(doi, serverHttpGet).then(function (found) {
    sendJson(res, 200, {
      found: true,
      doi: doi,
      source: found.source,
      partial: !!found.partial,
      paper: found.paper,
      attempts: found.attempts
    });
  }, function (err) {
    var kind = (err && err.kind) || 'unavailable';
    var status = kind === 'not_found' ? 404 : (kind === 'invalid' ? 400 : 503);
    sendJson(res, status, {
      found: false,
      doi: doi,
      error: { kind: kind, message: (err && err.message) || '文献元数据查询失败。' },
      attempts: (err && err.attempts) || []
    });
  });
}

// 静态文件托管（限制在项目目录内，防路径穿越）
function serveStatic(req, res, urlObj) {
  var pathname = decodeURIComponent(urlObj.pathname);
  if (pathname === '/') pathname = '/index.html';
  // 拒绝下发点开头的服务端配置文件（如 .email.config.json，含 SMTP 凭据与投递密钥）
  if (/(^|\/)\./.test(pathname) || pathname.indexOf('..') >= 0) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  var filePath = path.normalize(path.join(ROOT, pathname));
  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  // 服务端源码/配置文件不允许被公网下载：只下发 assets/ 目录内的前端资源与白名单页面。
  // （浏览器端只需 assets/*.js|css 与各 *.html 页面；server.js、email-sender.js、
  //   package.json 等属于服务端实现，泄露只会扩大攻击面。）
  var relPath = filePath.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, '');
  var isFrontAsset = /^assets\/[A-Za-z0-9._-]+\.(js|css|png|jpg|jpeg|svg|webp|ico)$/.test(relPath);
  var isPage = /^[A-Za-z0-9._-]+\.html$/.test(relPath);
  if (!isFrontAsset && !isPage) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面不存在</title></head>' +
        '<body style="font-family:sans-serif;max-width:560px;margin:80px auto;padding:0 16px">' +
        '<h2>页面不存在</h2><p><a href="/">返回首页</a></p></body></html>');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---- 邮件发件箱投递器 ----
// 设计要点：
//  * 附件上传事务只负责把邮件写入 email_outbox（同一事务内，失败不影响上传本身），
//    真正发信由本进程异步完成 —— 邮件发送失败绝不会回滚已成功的上传。
//  * 通过带投递凭据的服务端函数读取队列，凭据只存在于 .email.config.json，不进前端。
//  * email_outbox.dedupe_key 唯一约束保证同一附件不会重复发信；失败自动重试（最多 3 次）。
function rpcCall(fnName, args) {
  return new Promise(function (resolve, reject) {
    var url = DB_ORIGIN + '/.cloud/database/rest/v1/rpc/' + fnName;
    var payload = JSON.stringify(args || {});
    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-wb-webapp-access-key': PUBLIC_KEY,
      'Accept': 'application/json'
    };
    if (args && args.__token) {
      // 需要用户上下文的函数（auth.uid()）用用户自己的 access token 调用，服务端不伪造身份
      headers.Authorization = 'Bearer ' + args.__token;
      delete args.__token;
      payload = JSON.stringify(args);
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    var req = require('https').request(url, { method: 'POST', headers: headers }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var body = null;
        try { body = JSON.parse(text); } catch (e) { /* 保留原文 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        var msg = (body && (body.message || (body.error && body.error.message))) || text.slice(0, 200);
        var err = new Error(msg);
        err.status = res.statusCode;
        err.raw = body;
        reject(err);
      });
    });
    req.setTimeout(15000, function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end(payload);
  });
}

// ---- 平台认证服务（托管身份层）----
// 说明：WorkBuddy 托管认证没有「把手机号/邮箱绑定到已有用户」的公开接口，
// 但它的登录用户名解析直接读 auth.users 的 email / phone_number（已用 /v1/signin
// 的 PASSWORD_NOT_SET 错误码实测确认：改这两列后该标识立刻归到同一 user_id）。
// 因此这里的分工是：
//   * 验证码的「真实性」完全交给平台：/v1/verification 真实下发短信/邮件，
//     /v1/verification/verify 校验通过才返回 verification_token（本服务不解码、不生成验证码）；
//   * 身份关联由数据库函数 bind_identity 用服务端凭据写入，前端拿不到该凭据。
var AUTH_ORIGIN = process.env.WB_AUTH_ORIGIN || (DB_ORIGIN + '/.cloud/auth');

function platformRequest(pathname, body, token) {
  return new Promise(function (resolve) {
    var payload = JSON.stringify(body || {});
    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-wb-webapp-access-key': PUBLIC_KEY,
      'Accept': 'application/json'
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    var req = require('https').request(AUTH_ORIGIN + pathname, { method: 'POST', headers: headers }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, json: json, text: text });
      });
    });
    req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
    req.on('error', function (err) { resolve({ status: 0, json: null, text: String(err && err.message) }); });
    req.end(payload);
  });
}

function platformGetUser(token) {
  return new Promise(function (resolve) {
    var req = require('https').request(AUTH_ORIGIN + '/v1/user/me', {
      method: 'GET',
      headers: {
        'x-wb-webapp-access-key': PUBLIC_KEY,
        'Accept': 'application/json',
        Authorization: 'Bearer ' + token
      }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (res.statusCode === 200 && json) {
          var uid = json.sub || json.id || (json.user && (json.user.sub || json.user.id)) || '';
          return resolve({ ok: true, uid: String(uid || '') });
        }
        resolve({ ok: false, status: res.statusCode || 0 });
      });
    });
    req.setTimeout(12000, function () { req.destroy(new Error('timeout')); });
    req.on('error', function () { resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

function workerSecret() {
  return process.env.EMAIL_WORKER_SECRET || readServerConfig().workerSecret || '';
}

// 取调用者令牌。
// 注意：托管平台会给 /api/* 请求注入自己的 Authorization（分享链接访客会话），
// 会覆盖页面自己发的登录令牌，导致服务端只看到「别人的令牌」。
// 因此页面改用自定义头 x-wb-user-token 传登录令牌，这里优先读它。
function tokenSource(req) {
  if (String((req.headers && req.headers['x-wb-user-token']) || '').trim()) return 'x-wb-user-token';
  if (/^Bearer\s+/i.test(String((req.headers && req.headers.authorization) || ''))) return 'authorization';
  return 'none';
}

function bearerToken(req) {
  var custom = String((req.headers && req.headers['x-wb-user-token']) || '').trim();
  if (custom) return custom;
  var h = req.headers.authorization || '';
  var m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function readJsonBody(req, limit) {
  return new Promise(function (resolve) {
    var chunks = [];
    var size = 0;
    var failed = false;
    req.on('data', function (c) {
      if (failed) return;
      size += c.length;
      if (size > (limit || 4096)) {
        failed = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) { resolve(null); }
    });
  });
}

// POST /api/link/send：请求平台真实下发验证码（短信 / 邮件）
// body: { kind: 'phone'|'email', value }
// 已登录时（Authorization: Bearer <access_token>）先做占用预检查，避免给别人的号码发短信
function handleLinkSend(req, res) {
  readJsonBody(req).then(function (body) {
    if (!body) { sendJson(res, 400, { error: { kind: 'bad_request', message: '请求内容不合法。' } }); return; }
    var kind = body.kind === 'phone' ? 'phone' : (body.kind === 'email' ? 'email' : '');
    var value = String(body.value || '').trim();
    if (!kind || !value) { sendJson(res, 400, { error: { kind: 'bad_request', message: '请填写要绑定的手机号或邮箱。' } }); return; }

    var token = bearerToken(req);
    var uidPromise = token ? platformGetUser(token) : Promise.resolve({ ok: false });

    uidPromise.then(function (who) {
      var uid = who.ok ? who.uid : '';
      var pre = uid
        ? rpcCall('link_precheck', { p_secret: workerSecret(), p_uid: uid, p_kind: kind, p_value: value })
        : Promise.resolve({ state: 'free' });
      return pre.then(function (st) {
        if (st && st.state === 'taken') {
          sendJson(res, 409, {
            error: {
              kind: 'already_taken',
              message: (kind === 'phone' ? '该手机号' : '该邮箱') +
                '已绑定到其他账号。请用原账号登录后在个人中心管理，系统不会自动合并账号。'
            }
          });
          return;
        }
        if (st && st.state === 'mine') {
          sendJson(res, 200, { ok: true, alreadyLinked: true, value: st.value });
          return;
        }
        // 先过本站限流（60 秒 / 同一号码 10 分钟 5 次），再交给平台真实下发
        return rpcCall('claim_link_send', { p_secret: workerSecret(), p_kind: kind, p_value: value, p_uid: uid || null })
          .then(function (gate) {
            if (!gate || gate.ok !== true) {
              var wait = (gate && gate.retry_after) || 60;
              sendJson(res, 429, {
                error: {
                  kind: 'rate_limited',
                  message: (gate && gate.reason === 'cooldown' ? '发送过于频繁，请 ' : '同一号码发送次数过多，请 ') + wait + ' 秒后再试。'
                }
              });
              return;
            }
            var normalized = gate.value;
            var payload = kind === 'phone'
              ? { phone_number: normalized, target: 'ANY' }
              : { email: normalized, usage: 'email' };
            return platformRequest('/v1/verification', payload).then(function (r) {
              var ok = r.status >= 200 && r.status < 300 && r.json && typeof r.json.verification_id === 'string';
              if (!ok) {
                var msg = (r.json && (r.json.error_description || r.json.message || r.json.error)) || '';
                if (r.status === 0) msg = '无法连接认证服务，请稍后重试。';
                sendJson(res, 502, {
                  error: { kind: 'provider_failed', message: '验证码下发失败：' + (msg || ('HTTP ' + r.status)) }
                });
                return;
              }
              sendJson(res, 200, {
                ok: true,
                kind: kind,
                value: normalized,
                verificationId: r.json.verification_id,
                isExistingUser: r.json.is_user === true
              });
            });
          });
      });
    }).catch(function (err) {
      sendJson(res, 500, { error: { kind: 'server_error', message: '服务异常：' + (err && err.message ? err.message : '未知错误') } });
    });
  });
}

// POST /api/link/confirm：校验平台验证码 → 用服务端凭据把手机号/邮箱关联到当前登录用户
// body: { kind, value, verificationId, code }
function handleLinkConfirm(req, res) {
  readJsonBody(req).then(function (body) {
    if (!body) { sendJson(res, 400, { error: { kind: 'bad_request', message: '请求内容不合法。' } }); return; }
    var token = bearerToken(req);
    if (!token) { sendJson(res, 401, { error: { kind: 'unauthenticated', message: '请先登录后再绑定。' } }); return; }
    var kind = body.kind === 'phone' ? 'phone' : (body.kind === 'email' ? 'email' : '');
    var value = String(body.value || '').trim();
    var vid = String(body.verificationId || '').trim();
    var code = String(body.code || '').trim();
    if (!kind || !value || !vid || !code) {
      sendJson(res, 400, { error: { kind: 'bad_request', message: '请填写完整信息并获取验证码。' } });
      return;
    }

    platformGetUser(token).then(function (who) {
      if (!who.ok || !who.uid) {
        sendJson(res, 401, { error: { kind: 'unauthenticated', message: '登录状态已失效，请重新登录。' } });
        return;
      }
      platformRequest('/v1/verification/verify', { verification_id: vid, verification_code: code }).then(function (r) {
        var verified = r.status >= 200 && r.status < 300 && r.json && typeof r.json.verification_token === 'string';
        if (!verified) {
          var msg = (r.json && (r.json.error_description || r.json.message || r.json.error)) || '';
          sendJson(res, 400, {
            error: { kind: 'invalid_code', message: '验证码错误或已过期，请重新获取。' + (msg ? '（' + msg + '）' : '') }
          });
          return;
        }
        // verification_token 只作为「所有权已验证」的凭据使用，不用于登录，也不返回给前端
        rpcCall('bind_identity', {
          p_secret: workerSecret(), p_uid: who.uid, p_kind: kind, p_value: value
        }).then(function (state) {
          sendJson(res, 200, { ok: true, state: state });
        }, function (err) {
          var taken = /已绑定到其他账号|已被其他账号占用/.test(err.message || '');
          sendJson(res, taken ? 409 : 400, {
            error: { kind: taken ? 'already_taken' : 'bind_failed', message: err.message || '绑定失败，请稍后重试。' }
          });
        });
      });
    }).catch(function (err) {
      sendJson(res, 500, { error: { kind: 'server_error', message: '服务异常：' + (err && err.message ? err.message : '未知错误') } });
    });
  });
}


var emailState = { running: false, lastRun: null, lastError: null, sent: 0, failed: 0, lastResult: null };

// ---- 邮件功能暂停开关（2026-10-27）----
// 1 = 暂停：不做任何 SMTP 连接/发送/端口探测，未发送邮件保持 queued 原状（不重试、不删除）；
//     上传、审核、积分、站内通知完全不依赖邮件成功。
// 0 = 恢复：恢复后队列中积压的 queued 邮件会被正常投递（attempts 从当前值继续）。
// 可用环境变量 MAIL_PAUSED=0 覆盖；默认暂停。
var MAIL_PAUSED = String(process.env.MAIL_PAUSED == null ? '1' : process.env.MAIL_PAUSED) !== '0';
var MAIL_PAUSE_NOTE = '邮件提醒暂未启用：邮件已入队保存，恢复后将统一投递；站内通知不受影响。';

function emailStatusLite(smtpOverride) {
  var smtp = smtpOverride || SENDER.loadConfig();
  return {
    smtpConfigured: !!smtp.configured,
    smtpReason: smtp.configured ? null : smtp.reason,
    smtpHost: smtp.configured ? (smtp.host + ':' + smtp.port) : null,
    lastRun: emailState.lastRun,
    lastError: emailState.lastError,
    sentThisRun: emailState.sent,
    failedThisRun: emailState.failed,
    lastResult: emailState.lastResult
  };
}

// ---- 邮件相关接口的访问控制 ----
// 邮件队列属于服务端能力，不能对匿名开放：
//  * worker：持有服务端投递凭据（x-email-worker-key 头或 key 参数）
//  * admin ：已登录且 is_admin() 为真
//  * user  ：任意已登录用户（仅 /api/email/pump 允许，用于上传成功后立即触发一次投递）
function readWorkerKey(req, urlObj) {
  var h = String((req.headers && req.headers['x-email-worker-key']) || '');
  var q = urlObj ? String(urlObj.searchParams.get('key') || '') : '';
  return (h || q).trim();
}

// 用调用者自己的 JWT 复核身份：优先单次数据库函数 whoami()（SECURITY DEFINER，
// 不受 admins 表 RLS 影响，也不依赖额外的平台身份接口）；
// 失败时退回「平台身份接口 + is_admin()」的老路径，两条路都失败才判定为非管理员。
function platformWhoIs(token) {
  return platformGetUser(token).then(function (who) {
    if (!who.ok || !who.uid) {
      return { ok: false, role: 'anon', reason: 'PLATFORM_ME_' + (who.status || 0), detail: '登录态无效或已过期' };
    }
    return rpcCall('is_admin', { __token: token }).then(function (r) {
      var admin = (r === true) || (r && r.is_admin === true) || (Array.isArray(r) && r[0] === true);
      return { ok: true, role: admin ? 'admin' : 'user', uid: String(who.uid), reason: 'platform_me' };
    }, function (e) {
      return {
        ok: true, role: 'user', uid: String(who.uid),
        reason: 'PLATFORM_IS_ADMIN_' + ((e && e.status) || 0),
        detail: (e && e.message) || ''
      };
    });
  });
}

function whoIs(req, urlObj) {
  var secret = workerSecret();
  var key = readWorkerKey(req, urlObj);
  if (secret && key && key === secret) return Promise.resolve({ ok: true, role: 'worker', reason: 'worker_key' });
  var token = bearerToken(req);
  if (!token) {
    return Promise.resolve({
      ok: false, role: 'anon', reason: 'NO_TOKEN',
      detail: '缺少登录凭据或服务端投递凭据'
    });
  }
  return rpcCall('whoami', { __token: token }).then(function (r) {
    var w = (Array.isArray(r) ? r[0] : r) || {};
    if (w.ok && w.uid) {
      return { ok: true, role: w.is_admin === true ? 'admin' : 'user', uid: String(w.uid), reason: 'whoami' };
    }
    return platformWhoIs(token).then(function (f) {
      f.reason = 'WHOAMI_' + (w.reason || 'NO_UID') + '|' + f.reason;
      return f;
    });
  }, function (e) {
    return platformWhoIs(token).then(function (f) {
      f.reason = 'WHOAMI_ERR_' + ((e && e.status) || 0) + '|' + f.reason;
      f.detail = f.detail || (e && e.message) || '';
      return f;
    });
  });
}

function logGate(pathname, who) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), chan: 'auth', stage: 'admin_gate', path: pathname,
      role: (who && who.role) || 'anon', reason: (who && who.reason) || null,
      uidSuffix: who && who.uid ? String(who.uid).slice(-4) : null
    }));
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function denyUnauthorized(res, who) {
  if (who) logGate(null, who);
  sendJson(res, 401, {
    ok: false,
    error: {
      kind: 'unauthorized',
      message: '该接口需要登录态（管理员接口还需管理员权限）或服务端投递凭据，不对匿名开放。',
      // reason 只用于排查身份判定链路，不含令牌与邮箱明文
      reason: (who && who.reason) || 'NO_TOKEN',
      detail: (who && who.detail) || ''
    }
  });
}

// 发送通道自检邮件（调用前必须已完成管理员 / 服务端凭据校验）
function sendTestMail(res, tcfg, req) {
  readJsonBody(req, 2048).then(function (body) {
    var to = String((body && body.to) || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      sendJson(res, 400, { ok: false, error: '收件人邮箱不合法' });
      return;
    }
    SENDER.sendMail({
      to: to,
      subject: '科研互助平台：邮件通道自检',
      text: '这是一封来自科研互助平台的通道自检邮件。\n\n如果你收到这封邮件，说明平台的 SMTP 发信通道已经可用，' +
        '应助文件上传后给求助人发送的审核提醒也会正常发出。\n\n发送时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      smtp: tcfg
    }).then(function (r) {
      sendJson(res, 200, {
        ok: true, to: to, smtpHost: tcfg.host + ':' + tcfg.port,
        smtpCode: (r && r.code) || null, accepted: true,
        note: '服务商已接受该邮件（SMTP ' + ((r && r.code) || '') + '），不代表收件箱一定收到，请同时检查垃圾邮件。'
      });
    }, function (e) {
      sendJson(res, 200, {
        ok: false, to: to, stage: (e && e.stage) || null, smtpCode: (e && e.smtpCode) || null,
        error: (e && e.message) || '未知错误'
      });
    });
  }, function (e) {
    sendJson(res, 400, { ok: false, error: '请求体解析失败：' + (e && e.message) });
  });
}

// 出站 TCP 连通性探测（用于验证托管环境能否连上 SMTP 端口）
function probeTcp(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    var started = Date.now();
    var done = false;
    var sock = net.connect({ host: host, port: port });
    function finish(ok, err) {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve({ host: host, port: port, reachable: ok, ms: Date.now() - started, error: ok ? null : (err || null) });
    }
    sock.setTimeout(timeoutMs || 6000, function () { finish(false, 'timeout'); });
    sock.on('connect', function () { finish(true); });
    sock.on('error', function (e) { finish(false, e.code || e.message); });
  });
}

// 出站 SMTP 连通性诊断（调用前必须已完成管理员 / 服务端凭据校验）
function runDiagnose(res, urlObj) {
  resolveSmtp().then(function (dcfg) {
  var allow = ['smtp.163.com', 'smtp.126.com', 'smtp.qq.com', 'smtp.exmail.qq.com',
    'smtp-mail.outlook.com', 'smtp.office365.com', 'smtp.gmail.com', 'smtp.feishu.cn', 'smtpdm.aliyun.com'];
  var targets = [];
  if (dcfg.configured) targets.push([dcfg.host, dcfg.port]);
  var extra = String(urlObj.searchParams.get('host') || '').toLowerCase();
  if (extra && allow.indexOf(extra) >= 0 && (!dcfg.configured || dcfg.host !== extra)) {
    targets.push([extra, parseInt(urlObj.searchParams.get('port') || '465', 10)]);
  }
  if (!targets.length) targets.push(['smtp.163.com', 465], ['smtp.qq.com', 465]);
  Promise.all(targets.map(function (t) { return probeTcp(t[0], t[1], 6000); })).then(function (rs) {
    sendJson(res, 200, {
      ok: true,
      from: 'deployed-server',
      smtpConfigured: !!dcfg.configured,
      results: rs,
      note: 'TCP 握手测试：reachable=true 表示当前托管环境可直连该 SMTP 端口。'
    });
  });
  });
}

// 结构化邮件日志：单行 JSON，便于检索与告警。
// 只记录「收件邮箱是否存在」，不记录邮箱地址本身，也不记录授权码 / 验证码 / 任何密钥。
function logMail(ev) {
  var rec = {
    ts: new Date().toISOString(),
    chan: 'mail',
    outboxId: ev.outboxId || null,
    requestId: ev.requestId || null,
    attachmentId: ev.attachmentId || null,
    kind: ev.kind || null,
    recipientId: ev.recipientId || null,
    hasRecipientEmail: ev.hasRecipientEmail === true,
    stage: ev.stage || null,
    attempt: ev.attempt || null,
    result: ev.result || null,
    smtpCode: ev.smtpCode || null,
    smtpHost: ev.smtpHost || null,
    errorCode: ev.errorCode || null,
    message: ev.message || null
  };
  var line = JSON.stringify(rec);
  if (ev.result === 'failed') console.warn(line); else console.log(line);
  return rec;
}

// ---- SMTP 配置来源 ----
// 优先级：云端凭据库（app_secret.smtp_*，仅持服务端投递密钥可读取明文）
//        > 服务端本地 .email.config.json / 环境变量。
// 云端配置带 60 秒缓存，避免每封邮件都回源；授权码本身不落盘、不进日志、不进部署包。
var smtpCache = { at: 0, cfg: null };

function fetchSmtpConfig(force) {
  var secret = workerSecret();
  if (!secret) return Promise.resolve(null);
  if (!force && smtpCache.cfg && (Date.now() - smtpCache.at) < 60000) return Promise.resolve(smtpCache.cfg);
  return rpcCall('worker_get_smtp_secret', { p_secret: secret }).then(function (r) {
    var j = Array.isArray(r) ? r[0] : r;
    if (j && j.ok && j.configured && j.host && j.pass) {
      smtpCache.cfg = {
        configured: true,
        host: j.host,
        port: j.port,
        secure: !!j.secure,
        user: j.user || '',
        pass: j.pass,
        from: j.from || ('科研互助平台 <' + (j.user || 'no-reply@localhost') + '>'),
        rejectUnauthorized: true,
        source: 'db'
      };
    } else {
      smtpCache.cfg = null;
    }
    smtpCache.at = Date.now();
    return smtpCache.cfg;
  }, function () {
    smtpCache.at = Date.now();
    return null;
  });
}

function resolveSmtp(force) {
  return fetchSmtpConfig(force).then(function (db) {
    return db || SENDER.loadConfig();
  });
}

// 发送单封邮件并回写结果；永远 resolve，绝不因单封失败中断整批
function sendOne(secret, item, smtp) {
  var base = {
    outboxId: item.id,
    requestId: item.request_id || null,
    attachmentId: item.attachment_id || null,
    kind: item.kind || null,
    recipientId: item.recipient_id || null,
    hasRecipientEmail: !!item.recipient_email,
    attempt: item.attempts || null
  };
  return new Promise(function (resolve) {
    // 阶段 1：请求已提交给 SMTP 通道
    logMail(Object.assign({}, base, { stage: 'submitting', result: 'submitted' }));

    SENDER.sendMail({ to: item.recipient_email, subject: item.subject, text: item.body, smtp: smtp })
      .then(function (r) {
        emailState.sent++;
        // 阶段 2：服务商在 DATA 结束后返回 2xx，表示已接受该邮件。
        // 注意：这是「服务商已接受」，不是「收件箱已收到」，产品与日志都不得夸大为已送达。
        logMail(Object.assign({}, base, {
          stage: 'accepted',
          result: 'accepted',
          smtpCode: (r && r.code) || null,
          smtpHost: (r && r.host) ? (r.host + ':' + r.port) : null,
          message: '服务商已接受该邮件（不等于收件箱已收到）'
        }));
        return { ok: true, stage: 'accepted', smtpCode: (r && r.code) || null };
      }, function (err) {
        emailState.failed++;
        var msg = (err && err.message) || '未知错误';
        emailState.lastError = msg;
        var stage = (err && err.stage) || 'send';
        logMail(Object.assign({}, base, {
          stage: stage,
          result: 'failed',
          smtpCode: (err && err.smtpCode) || null,
          errorCode: 'SMTP_' + String(stage).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase(),
          message: msg
        }));
        return { ok: false, stage: stage, smtpCode: (err && err.smtpCode) || null, error: msg };
      })
      .then(function (r) {
        rpcCall('finish_email', {
          p_secret: secret,
          p_id: item.id,
          p_ok: r.ok,
          p_error: r.ok ? null : r.error,
          p_stage: r.stage,
          p_smtp_code: (r.smtpCode === null || r.smtpCode === undefined) ? null : String(r.smtpCode)
        }).then(function () {
          logMail(Object.assign({}, base, {
            stage: r.ok ? 'recorded_sent' : 'recorded_failed',
            result: r.ok ? 'recorded_sent' : 'recorded_failed'
          }));
        }, function (e) {
          logMail(Object.assign({}, base, {
            stage: 'writeback_failed',
            result: 'failed',
            errorCode: 'WRITEBACK_FAILED',
            message: (e && e.message) || '回写失败'
          }));
        });
        resolve(r);
      });
  });
}

// 投递一轮发件箱。任何异常都被收敛为返回值，不会抛到定时器外导致进程崩溃。
function processOutbox() {
  if (MAIL_PAUSED) {
    // 暂停期间：不 claim、不发送、不重试、不改任何队列行的状态
    emailState.lastError = null;
    emailState.lastResult = { ok: true, paused: true, reason: MAIL_PAUSE_NOTE };
    return Promise.resolve(emailState.lastResult);
  }
  emailState.lastRun = new Date().toISOString();
  if (emailState.running) return Promise.resolve({ ok: true, skipped: true, reason: '上一轮仍在投递中' });

  var secret = workerSecret();
  if (!secret) {
    emailState.lastError = '缺少 workerSecret 配置';
    return Promise.resolve({ ok: false, error: emailState.lastError });
  }
  emailState.running = true;

  return resolveSmtp().then(function (smtp) {
    if (!smtp.configured) {
      emailState.lastError = '邮件服务未配置：' + smtp.reason;
      emailState.running = false;
      return { ok: false, error: emailState.lastError, smtpConfigured: false };
    }
    emailState.sent = 0;
    emailState.failed = 0;
    var summary = { ok: true, claimed: 0, sent: 0, failed: 0, smtpSource: smtp.source || 'file' };

    return rpcCall('claim_emails', { p_secret: secret, p_limit: 10 })
      .then(function (rows) {
        var list = Array.isArray(rows) ? rows : [];
        summary.claimed = list.length;
        var chain = Promise.resolve();
        list.forEach(function (item) {
          chain = chain.then(function () { return sendOne(secret, item, smtp); });
        });
        return chain;
      })
      .then(function () {
        summary.sent = emailState.sent;
        summary.failed = emailState.failed;
        if (summary.sent) emailState.lastError = null;
        emailState.lastResult = summary;
        return summary;
      }, function (err) {
        summary.ok = false;
        summary.error = '队列读取失败：' + (err && err.message ? err.message : '未知错误');
        emailState.lastError = summary.error;
        emailState.lastResult = summary;
        console.warn('[邮件投递] ' + summary.error);
        return summary;
      })
      .then(function (r) {
        emailState.running = false;
        return r;
      }, function (e) {
        emailState.running = false;
        emailState.lastError = '投递异常：' + (e && e.message ? e.message : '未知错误');
        return { ok: false, error: emailState.lastError };
      });
  }, function (e) {
    emailState.running = false;
    emailState.lastError = '读取邮件配置失败：' + (e && e.message ? e.message : '未知错误');
    return { ok: false, error: emailState.lastError };
  });
}

function safePump() {
  try {
    processOutbox().catch(function (e) {
      emailState.running = false;
      emailState.lastError = '投递异常：' + (e && e.message ? e.message : '未知错误');
      console.warn('[邮件投递] ' + emailState.lastError);
    });
  } catch (e) {
    emailState.running = false;
    emailState.lastError = '投递异常：' + (e && e.message ? e.message : '未知错误');
  }
}

// 队列轮询（沙箱内无常驻任务调度，用进程内定时器；失败仅记录，不影响网站可用性）
// 暂停期间不启动轮询，彻底不产生 SMTP 连接
if (!MAIL_PAUSED) {
  setTimeout(safePump, 1200).unref();
  setInterval(safePump, 30000).unref();
}

var server = http.createServer(function (req, res) {
  var urlObj;
  try {
    urlObj = new URL(req.url, 'http://localhost');
  } catch (e) {
    sendJson(res, 400, { error: { kind: 'bad_request', message: '请求地址不合法。' } });
    return;
  }
  if (urlObj.pathname.indexOf('/.cloud/') === 0) {
    proxyCloud(req, res, urlObj, DB_ORIGIN);
    return;
  }
  if (urlObj.pathname.indexOf('/api/') === 0 && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }
  if (urlObj.pathname === '/api/paper-meta') {
    handlePaperMeta(req, res, urlObj);
    return;
  }
  // 绑定手机号 / 邮箱：验证码由平台真实下发，绑定写入由服务端凭据完成
  if (urlObj.pathname === '/api/link/send') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '请使用 POST。' } }); return; }
    handleLinkSend(req, res);
    return;
  }
  if (urlObj.pathname === '/api/link/confirm') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '请使用 POST。' } }); return; }
    handleLinkConfirm(req, res);
    return;
  }
  if (urlObj.pathname === '/api/email/status') {
    resolveSmtp().then(function (smtp) {
    var st = emailStatusLite(smtp);
    var payload = {
      ok: true,
      paused: MAIL_PAUSED,
      smtpConfigured: st.smtpConfigured,
      smtpSource: smtp && smtp.source ? smtp.source : null,
      smtpReason: st.smtpReason,
      smtpHost: st.smtpHost,
      worker: {
        lastRun: st.lastRun,
        lastError: st.lastError,
        sentThisRun: st.sentThisRun,
        failedThisRun: st.failedThisRun,
        lastResult: st.lastResult
      },
      note: MAIL_PAUSED
        ? MAIL_PAUSE_NOTE
        : (st.smtpConfigured
          ? '邮件服务已配置：上传成功后会立即触发一次投递，另有 30 秒轮询兜底。'
          : '邮件服务未配置：请管理员在「邮件服务配置」页面填写 SMTP 主机/端口/账号/授权码。')
    };
    // 详细模式会带出收件人邮箱，必须提供服务端投递凭据，避免公网任意读取
    if (urlObj.searchParams.get('detail') === '1') {
      var detailKey = urlObj.searchParams.get('key') || '';
      var realSecret = workerSecret();
      if (!realSecret || detailKey !== realSecret) {
        sendJson(res, 403, { ok: false, error: { kind: 'forbidden', message: '查看投递明细需要服务端投递凭据。' } });
        return;
      }
      rpcCall('email_outbox_recent', { p_secret: realSecret, p_limit: 20 }).then(function (d) {
        payload.outbox = d || null;
        sendJson(res, 200, payload);
      }, function (e) {
        payload.outbox = { error: e.message };
        sendJson(res, 200, payload);
      });
      return;
    }
    sendJson(res, 200, payload);
    }, function () {
      sendJson(res, 200, { ok: true, smtpConfigured: false, note: '读取邮件配置失败' });
    });
    return;
  }

  // 立即投递一轮发件箱：上传成功后由页面调用，避免依赖定时器（托管环境可能在空闲时挂起进程）
  if (urlObj.pathname === '/api/email/pump') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '请使用 POST。' } });
      return;
    }
    // 必须已登录（或持有服务端投递凭据）才能触发投递，避免被匿名滥用为放大攻击
    whoIs(req, urlObj).then(function (who) {
      if (['worker', 'admin', 'user'].indexOf(who.role) < 0) { denyUnauthorized(res, who); return; }
      if (MAIL_PAUSED) {
        // 暂停期间：立即返回，不做任何投递动作（页面可静默忽略）
        sendJson(res, 200, { ok: true, paused: true, triggeredBy: who.role, note: MAIL_PAUSE_NOTE });
        return;
      }
      processOutbox().then(function (r) {
        sendJson(res, 200, { ok: true, triggeredBy: who.role, result: r, status: emailStatusLite() });
      }, function (e) {
        sendJson(res, 200, { ok: false, error: (e && e.message) || '未知错误', status: emailStatusLite() });
      });
    }, function (e) {
      sendJson(res, 500, { ok: false, error: { kind: 'server_error', message: (e && e.message) || '未知错误' } });
    });
    return;
  }

  // 发送通道自检：用当前 SMTP 配置向指定地址发一封测试邮件，返回服务商的真实应答
  if (urlObj.pathname === '/api/email/test') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '请使用 POST。' } });
      return;
    }
    // 该接口可让服务器向任意地址发信，必须限管理员 / 服务端凭据，否则等于开放中继
    whoIs(req, urlObj).then(function (who) {
      if (['worker', 'admin'].indexOf(who.role) < 0) { denyUnauthorized(res, who); return; }
      if (MAIL_PAUSED) {
        sendJson(res, 503, { ok: false, paused: true, error: MAIL_PAUSE_NOTE });
        return;
      }
      resolveSmtp().then(function (tcfg) {
        if (!tcfg.configured) {
          sendJson(res, 200, { ok: false, error: '邮件服务未配置：' + tcfg.reason });
          return;
        }
        sendTestMail(res, tcfg, req);
      }, function (e) {
        sendJson(res, 500, { ok: false, error: '读取邮件配置失败：' + ((e && e.message) || '未知错误') });
      });
    }, function (e) {
      sendJson(res, 500, { ok: false, error: { kind: 'server_error', message: (e && e.message) || '未知错误' } });
    });
    return;
  }

  // 出站连通性诊断：在托管环境里实测能否连上 SMTP 端口（只允许常见邮件服务商，避免被当作端口扫描器）
  if (urlObj.pathname === '/api/email/diagnose') {
    whoIs(req, urlObj).then(function (who) {
      if (['worker', 'admin'].indexOf(who.role) < 0) { denyUnauthorized(res, who); return; }
      if (MAIL_PAUSED) {
        sendJson(res, 200, { ok: true, paused: true, results: [], note: MAIL_PAUSE_NOTE });
        return;
      }
      runDiagnose(res, urlObj);
    }, function (e) {
      sendJson(res, 500, { ok: false, error: { kind: 'server_error', message: (e && e.message) || '未知错误' } });
    });
    return;
  }
  // 读取当前邮件服务配置（脱敏：不返回授权码明文，只返回是否已设置）
  if (urlObj.pathname === '/api/admin/smtp/status') {
    whoIs(req, urlObj).then(function (who) {
      if (['worker', 'admin'].indexOf(who.role) < 0) { denyUnauthorized(res, who); return; }
      var token = bearerToken(req);
      if (who.role === 'admin' && token) {
        rpcCall('admin_get_smtp_status', { __token: token }).then(function (r) {
          var j = Array.isArray(r) ? r[0] : r;
          sendJson(res, 200, j || { ok: false, error: '读取配置失败' });
        }, function (e) {
          sendJson(res, 200, { ok: false, error: '读取配置失败：' + ((e && e.message) || '未知错误') });
        });
        return;
      }
      resolveSmtp(true).then(function (c) {
        sendJson(res, 200, {
          ok: true,
          configured: !!(c && c.configured),
          host: (c && c.host) || '',
          port: (c && c.port) || 0,
          secure: !!(c && c.secure),
          user: (c && c.user) || '',
          from: (c && c.from) || '',
          passSet: !!(c && c.pass)
        });
      });
    }, function (e) {
      sendJson(res, 500, { ok: false, error: { kind: 'server_error', message: (e && e.message) || '未知错误' } });
    });
    return;
  }

  // 保存邮件服务配置并立即做一次真实的「连接 + 身份认证」握手（不发信）。
  // 授权码只经 HTTPS 传入、直接写云端凭据库，不落本地文件、不进日志、不回显。
  if (urlObj.pathname === '/api/admin/smtp/save') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '请使用 POST。' } });
      return;
    }
    whoIs(req, urlObj).then(function (who) {
      if (who.role !== 'admin') { denyUnauthorized(res, who); return; }
      if (MAIL_PAUSED) {
        // 暂停期间不接受新的 SMTP 配置保存与连接测试，避免反复连接失败
        sendJson(res, 503, { ok: false, paused: true, error: MAIL_PAUSE_NOTE });
        return;
      }
      var token = bearerToken(req);
      readJsonBody(req, 4096).then(function (body) {
        var host = String((body && body.host) || '').trim();
        var port = parseInt((body && body.port), 10);
        var secure = body && typeof body.secure === 'boolean' ? body.secure : (port === 465);
        var user = String((body && body.user) || '').trim();
        var pass = body && typeof body.pass === 'string' ? body.pass : '';
        var from = String((body && body.from) || '').trim();
        if (!host || !port) { sendJson(res, 400, { ok: false, error: 'SMTP 主机与端口不能为空' }); return; }
        rpcCall('admin_save_smtp_config', {
          __token: token,
          p_host: host, p_port: port, p_secure: secure,
          p_user: user, p_pass: pass, p_from: from
        }).then(function (r) {
          var saved = Array.isArray(r) ? r[0] : r;
          smtpCache = { at: 0, cfg: null };
          if (!saved || saved.ok === false) {
            sendJson(res, 200, { ok: false, error: (saved && saved.error) || '保存失败' });
            return;
          }
          // 保存后立刻验证：真实连上 SMTP 主机并完成 AUTH LOGIN
          resolveSmtp(true).then(function (cfg) {
            if (!cfg.configured) {
              sendJson(res, 200, { ok: true, saved: saved, auth: { ok: false, error: '配置已保存但无法用于发信：' + (cfg.reason || '配置不完整') } });
              return;
            }
            SENDER.verifyAuth(cfg).then(function (v) {
              logMail({ stage: 'auth_check', result: 'ok', smtpHost: cfg.host + ':' + cfg.port, smtpCode: v.code, message: 'SMTP 身份认证通过' });
              sendJson(res, 200, {
                ok: true, saved: saved,
                auth: { ok: true, authenticated: true, stage: v.stage, smtpCode: v.code, host: v.host, port: v.port, secure: v.secure, elapsedMs: v.elapsedMs, message: 'SMTP 连接与身份认证成功（服务商响应 ' + v.code + '）' }
              });
            }, function (e) {
              logMail({ stage: 'auth_check', result: 'failed', smtpHost: cfg.host + ':' + cfg.port, smtpCode: (e && e.smtpCode) || null, errorCode: 'AUTH_' + String((e && e.stage) || 'unknown').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase(), message: (e && e.message) || '认证失败' });
              sendJson(res, 200, {
                ok: true, saved: saved,
                auth: { ok: false, authenticated: false, stage: (e && e.stage) || null, smtpCode: (e && e.smtpCode) || null, error: (e && e.message) || '认证失败' }
              });
            });
          });
        }, function (e) {
          sendJson(res, 200, { ok: false, error: '保存失败：' + ((e && e.message) || '未知错误') });
        });
      }, function (e) {
        sendJson(res, 400, { ok: false, error: '请求体解析失败：' + (e && e.message) });
      });
    }, function (e) {
      sendJson(res, 500, { ok: false, error: { kind: 'server_error', message: (e && e.message) || '未知错误' } });
    });
    return;
  }

  // 身份自检：只回传调用者自己的角色与判定链路原因，便于页面显示「为什么没有权限」。
  if (urlObj.pathname === '/api/whoami') {
    whoIs(req, urlObj).then(function (who) {
      sendJson(res, 200, {
        ok: who.ok === true,
        role: who.role || 'anon',
        reason: who.reason || null,
        detail: who.detail || null,
        uidSuffix: who.uid ? String(who.uid).slice(-4) : null,
        hasToken: !!bearerToken(req),
        tokenSource: tokenSource(req)
      });
    }, function (e) {
      sendJson(res, 500, { ok: false, error: { kind: 'server_error', message: (e && e.message) || '未知错误' } });
    });
    return;
  }

  if (urlObj.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { kind: 'method_not_allowed', message: '仅支持 GET 请求。' } });
    return;
  }
  serveStatic(req, res, urlObj);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('科研互助平台已启动：http://0.0.0.0:' + PORT);
});
