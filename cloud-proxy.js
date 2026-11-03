'use strict';

var https = require('node:https');

// Only the application's cloud APIs are relayed. User credentials pass through;
// this transport never supplies an administrator or worker credential.
module.exports = function proxyCloud(req, res, urlObj, origin) {
  var pathname;
  try { pathname = decodeURIComponent(urlObj.pathname); } catch (e) { pathname = ''; }
  if (!/^\/\.cloud\/(auth|database\/rest|storage)(\/|$)/.test(pathname) ||
      pathname.indexOf('\\') >= 0 || pathname.indexOf('\0') >= 0 ||
      pathname.split('/').some(function (part) { return part === '..'; })) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'bad_cloud_path' }));
    return;
  }

  var target = new URL(origin);
  if (target.protocol !== 'https:') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_cloud_origin' }));
    return;
  }
  target.pathname = urlObj.pathname;
  target.search = urlObj.search;
  var headers = { 'accept-encoding': 'identity' };
  ['authorization', 'x-wb-webapp-access-key', 'content-type', 'content-length',
    'accept', 'prefer', 'range', 'accept-profile', 'content-profile',
    'x-upsert', 'x-client-info'].forEach(function (name) {
    if (req.headers[name]) headers[name] = req.headers[name];
  });

  // These endpoints establish a session using credentials in the request body.
  // An inherited/stale bearer must not prevent a fresh password or OTP login.
  // Keep Authorization untouched on user/profile and all protected APIs.
  var publicAuthPaths = [
    '/.cloud/auth/v1/signin', '/.cloud/auth/v1/signup',
    '/.cloud/auth/v1/verification', '/.cloud/auth/v1/verification/verify',
    '/.cloud/auth/v1/token'
  ];
  if (publicAuthPaths.indexOf(pathname.replace(/\/$/, '')) >= 0) {
    delete headers.authorization;
  }

  // This is a server-to-server request, not a forwarded browser session.
  // Cookies, browser Origin/Referer and hosting-platform credentials stay local.
  var upstream = https.request(target, { method: req.method, headers: headers }, function (response) {
    var out = { 'cache-control': 'private, no-store' };
    ['content-type', 'content-encoding', 'content-length', 'content-range',
      'accept-ranges', 'content-disposition', 'retry-after', 'www-authenticate'].forEach(function (name) {
      if (response.headers[name]) out[name] = response.headers[name];
    });
    res.writeHead(response.statusCode, out);
    response.on('error', function () { res.destroy(); });
    response.pipe(res);
  });
  upstream.setTimeout(30000, function () { upstream.destroy(new Error('cloud_timeout')); });
  upstream.on('error', function () {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'cloud_unavailable', message: '云服务连接失败，请稍后重试。' }));
  });
  req.on('aborted', function () { upstream.destroy(); });
  req.on('error', function () { upstream.destroy(); });
  res.on('close', function () { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
};
