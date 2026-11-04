'use strict';
var https = require('node:https');
var context = require('./cloud-proxy.js');

// A diagnostic login path. No messages are sent, accounts created or secrets logged.
module.exports = async function otpLogin(req, res, origin, key) {
  function reply(status, data, cookies) {
    var headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
    if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  }
  if (req.method !== 'POST') return reply(405, { ok: false, stage: 'input', message: '请使用 POST。' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reply(415, { ok: false, stage: 'input' });
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403, { ok: false, stage: 'input' }); }
    catch (e) { return reply(403, { ok: false, stage: 'input' }); }
  }
  var body;
  try {
    var chunks = [], size = 0;
    for await (var chunk of req) {
      size += chunk.length;
      if (size > 8192) return reply(413, { ok: false, stage: 'input' });
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) { return reply(400, { ok: false, stage: 'input', message: '请求格式不正确。' }); }
  if (!body || typeof body !== 'object') return reply(400, { ok: false, stage: 'input' });
  var originMode = body.originMode || 'absent';
  if (originMode !== 'absent' && originMode !== 'registered') return reply(400, { ok: false, stage: 'input', message: '测试方式不正确。' });
  var email = typeof body.email === 'string' ? body.email.trim() : '';
  var phone = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '').replace(/^0086/, '') : '';
  if (phone.length === 13 && phone.indexOf('86') === 0) phone = phone.slice(2);
  var username = email || (/^1\d{10}$/.test(phone) ? '+86 ' + phone : '');
  if ((email && phone) || !username || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      typeof body.verificationId !== 'string' || !body.verificationId ||
      typeof body.code !== 'string' || !/^\d{4,8}$/.test(body.code)) {
    return reply(400, { ok: false, stage: 'input', message: '请检查账号、验证码，并先获取新的验证码。' });
  }
  var agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  var jar = new Map(), localCookies = [], trace = [], firstSocket, grantExpiry = null;
  context.readAuthCookies(req.headers.cookie).split(';').forEach(function (part) {
    var at = part.indexOf('=');
    if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1));
  });
  function call(stage, path, payload, token) {
    return new Promise(function (resolve, reject) {
      var data = payload === undefined ? null : JSON.stringify(payload);
      var headers = { 'x-wb-webapp-access-key': key, 'accept': 'application/json', 'accept-encoding': 'identity' };
      // Fixed application-owned upstream only. This option is diagnostic-only;
      // it does not change the normal cloud proxy's Origin policy.
      if (originMode === 'registered') headers.origin = new URL(origin).origin;
      var grantSeconds = grantExpiry === null ? null : grantExpiry - Math.floor(Date.now() / 1000);
      if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
      ['user-agent', 'accept-language'].forEach(function (h) { if (req.headers[h]) headers[h] = req.headers[h]; });
      if (jar.size) headers.cookie = Array.from(jar).map(function (pair) { return pair.join('='); }).join('; ');
      if (token) headers.authorization = 'Bearer ' + token;
      var socket, target = new URL(path, origin);
      var upstream = https.request(target, { method: data === null ? 'GET' : 'POST', agent: agent, headers: headers }, function (r) {
        var parts = [], bytes = 0;
        r.on('data', function (c) { bytes += c.length; if (bytes > 131072) upstream.destroy(new Error('response_too_large')); else parts.push(c); });
        r.on('error', reject);
        r.on('end', function () {
          var result;
          try { result = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (e) { result = {}; }
          var cookies = [].concat(r.headers['set-cookie'] || []);
          cookies.forEach(function (cookie) {
            var pair = cookie.split(';')[0], at = pair.indexOf('=');
            if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
            var local = context.localAuthCookie(cookie);
            if (local) localCookies.push(local);
          });
          trace.push({ stage: stage, status: r.statusCode, requestId: result.requestId || result.request_id ||
            r.headers['x-request-id'] || r.headers['x-cloudbase-request-id'] || '',
            cookieCount: cookies.length, originMode: originMode,
            declaredGrantSeconds: stage === 'signin' ? grantSeconds : null,
            sameConnectionAsVerify: firstSocket ? socket === firstSocket : null });
          if (!firstSocket) firstSocket = socket;
          resolve({ status: r.statusCode, data: result });
        });
      });
      upstream.on('socket', function (s) { socket = s; });
      upstream.setTimeout(20000, function () { upstream.destroy(new Error('upstream_timeout')); });
      upstream.on('error', reject);
      upstream.end(data);
    });
  }
  var stage = 'verify';
  function failure(r) {
    var message = String(r.data.error_description || r.data.message || '认证服务拒绝请求').slice(0, 800);
    [body.verificationId, body.code, verified && verified.data.verification_token,
      signed && signed.data.access_token, signed && signed.data.refresh_token].forEach(function (secret) {
      if (typeof secret === 'string' && secret) message = message.split(secret).join('[已隐藏]');
    });
    return reply(200, { ok: false, stage: stage, status: r.status,
      code: r.data.error || r.data.code || 'unknown', message: message, trace: trace }, localCookies);
  }
  try {
    var verified = await call(stage, '/.cloud/auth/v1/verification/verify', { verification_id: body.verificationId, verification_code: body.code });
    if (verified.status !== 200 || !verified.data.verification_token) return failure(verified);
    // Read only the declared expiry for diagnostics; this is not JWT validation.
    try {
      var segments = String(verified.data.verification_token).split('.');
      var claims = segments.length === 3 ? JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) : {};
      if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) grantExpiry = claims.exp;
    } catch (e) { /* Opaque or non-JWT grants are left untouched. */ }
    stage = 'signin';
    var signed = await call(stage, '/.cloud/auth/v1/signin', { username: username, verification_token: verified.data.verification_token });
    if (signed.status !== 200 || typeof signed.data.access_token !== 'string' || !signed.data.access_token) return failure(signed);
    stage = 'user';
    var user = await call(stage, '/.cloud/auth/v1/user/me', undefined, signed.data.access_token);
    if (user.status !== 200 || !(user.data.sub || user.data.uid || user.data.id)) return failure(user);
    return reply(200, { ok: true, stage: 'done', trace: trace, session: signed.data }, localCookies);
  } catch (e) {
    return reply(200, { ok: false, stage: stage, status: 502, code: 'upstream_unavailable', message: '上游连接失败，请稍后使用新验证码重试。', trace: trace });
  } finally { agent.destroy(); }
};
