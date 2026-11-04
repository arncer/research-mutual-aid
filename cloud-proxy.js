'use strict';

var https = require('node:https');
var AUTH_COOKIE_PREFIX = 'wbcloud_auth_';

function upstreamAuthCookies(cookieHeader) {
  return String(cookieHeader || '').split(';').map(function (part) {
    var at = part.indexOf('=');
    if (at < 0) return '';
    var name = part.slice(0, at).trim();
    if (name.indexOf(AUTH_COOKIE_PREFIX) !== 0) return '';
    try {
      var encoded = name.slice(AUTH_COOKIE_PREFIX.length);
      var original = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(original)) return '';
      return original + '=' + part.slice(at + 1).trim();
    } catch (e) { return ''; }
  }).filter(Boolean).join('; ');
}

function localAuthCookie(cookie) {
  var parts = String(cookie).split(';');
  var at = parts[0].indexOf('=');
  if (at < 1) return null;
  var original = parts[0].slice(0, at).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(original)) return null;
  var name = AUTH_COOKIE_PREFIX + Buffer.from(original).toString('base64url');
  var attrs = parts.slice(1).filter(function (attr) { return !/^\s*(domain|path)\s*=/i.test(attr); });
  if (!attrs.some(function (attr) { return /^\s*samesite\s*=/i.test(attr); })) attrs.push(' SameSite=Lax');
  if (!attrs.some(function (attr) { return /^\s*httponly\s*$/i.test(attr); })) attrs.push(' HttpOnly');
  return name + parts[0].slice(at) + '; Path=/.cloud/auth' +
    (attrs.length ? ';' + attrs.join(';') : '');
}

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
    'x-upsert', 'x-client-info', 'user-agent', 'accept-language'].forEach(function (name) {
    if (req.headers[name]) headers[name] = req.headers[name];
  });
  // The real-account diagnostic succeeds with this registered application
  // context, including /user/me. Use it consistently on session refresh,
  // protected reads and writes as well as on initial sign-in.
  // Derive it from the fixed server-side upstream, never from browser input.
  headers.origin = target.origin;

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

  var isAuth = pathname.indexOf('/.cloud/auth/') === 0;
  if (isAuth) {
    var cookie = upstreamAuthCookies(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
  }

  // This is a server-to-server request, not a forwarded browser session.
  // Only namespaced cloud-auth cookies make the round trip. Hosting-platform
  // cookies and browser Origin/Referer are not forwarded to the cloud API.
  // The application Origin above is set by this server, including for GETs
  // where browsers do not normally supply an Origin header.
  var upstream = https.request(target, { method: req.method, headers: headers }, function (response) {
    var out = { 'cache-control': 'private, no-store', 'x-wb-cloud-context': 'registered' };
    ['content-type', 'content-encoding', 'content-length', 'content-range',
      'accept-ranges', 'content-disposition', 'retry-after', 'www-authenticate',
      'x-request-id', 'x-cloudbase-request-id'].forEach(function (name) {
      if (response.headers[name]) out[name] = response.headers[name];
    });
    if (isAuth && response.headers['set-cookie']) {
      out['set-cookie'] = [].concat(response.headers['set-cookie']).map(localAuthCookie).filter(Boolean);
    }
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
module.exports.readAuthCookies = upstreamAuthCookies;
module.exports.localAuthCookie = localAuthCookie;
module.exports.readAuthCookies = upstreamAuthCookies;
module.exports.localAuthCookie = localAuthCookie;
