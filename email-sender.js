/* 科研互助平台 - 邮件发送模块（零依赖，直接实现 SMTP 协议）
 *
 * 为什么自己实现：
 *   项目发布时不允许联网安装 npm 依赖（package.json 保持无依赖），
 *   因此使用 Node 内置的 net / tls 直接完成 SMTP 会话，不引入 nodemailer。
 *
 * 配置来源：项目根目录 `.email.config.json`（以点开头，静态服务会拒绝下发该文件）
 *   {
 *     "host": "smtp.example.com",
 *     "port": 465,
 *     "secure": true,              // true=465 直连 TLS；false=587/25 走 STARTTLS
 *     "user": "no-reply@example.com",
 *     "pass": "SMTP 授权码",
 *     "from": "科研互助平台 <no-reply@example.com>",
 *     "rejectUnauthorized": true   // 自签证书环境可临时设为 false
 *   }
 *
 * 未配置时 configured=false，调用方必须如实告知「邮件服务未配置」，不得假装发送成功。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var net = require('net');
var tls = require('tls');

var CONFIG_FILE = path.join(__dirname, '.email.config.json');
var cached = null;

function loadConfig() {
  if (cached) return cached;

  var file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (e) {
    file = {};
  }

  // 环境变量优先（便于在托管控制台轮换凭据，不必把授权码写进文件）
  var env = process.env;
  var host = env.EMAIL_SMTP_HOST || file.host || '';
  var portRaw = env.EMAIL_SMTP_PORT || file.port || '';
  if (!host || !portRaw) {
    cached = {
      configured: false,
      reason: '配置文件缺少 host/port（也可用环境变量 EMAIL_SMTP_HOST / EMAIL_SMTP_PORT 提供）'
    };
    return cached;
  }

  var port = parseInt(portRaw, 10);
  if (!port) {
    cached = { configured: false, reason: 'SMTP 端口不合法：' + portRaw };
    return cached;
  }
  var secureFlag = env.EMAIL_SMTP_SECURE != null && env.EMAIL_SMTP_SECURE !== ''
    ? env.EMAIL_SMTP_SECURE !== 'false'
    : (file.secure !== false && port === 465);

  cached = {
    configured: true,
    host: String(host),
    port: port,
    secure: secureFlag,
    user: env.EMAIL_SMTP_USER != null && env.EMAIL_SMTP_USER !== '' ? env.EMAIL_SMTP_USER : (file.user || ''),
    pass: env.EMAIL_SMTP_PASS != null && env.EMAIL_SMTP_PASS !== '' ? env.EMAIL_SMTP_PASS : (file.pass || ''),
    from: env.EMAIL_SMTP_FROM || file.from || (file.user ? ('科研互助平台 <' + file.user + '>') : 'no-reply@localhost'),
    rejectUnauthorized: env.EMAIL_SMTP_REJECT_UNAUTHORIZED === 'false'
      ? false
      : (file.rejectUnauthorized !== false),
    source: env.EMAIL_SMTP_HOST ? 'env' : 'file'
  };
  return cached;
}

function resetConfigCache() { cached = null; }

// ---- 极简 SMTP 会话（按行读写，支持多行响应） ----
function createSession(socket) {
  var buf = '';
  var waiters = [];
  var closed = false;
  var lastError = null;

  socket.setEncoding('utf8');
  socket.on('data', function (chunk) {
    buf += chunk;
    drain();
  });
  socket.on('error', function (err) { lastError = err; closed = true; drain(); });
  socket.on('close', function () { closed = true; drain(); });

  function drain() {
    // 响应以 "250 " / "250-" 形式出现；以「三位码 + 空格」结束
    while (waiters.length) {
      var idx = buf.indexOf('\n');
      if (idx === -1) break;
      var lines = [];
      var consumed = 0;
      var done = false;
      var rest = buf;
      while (!done) {
        var nl = rest.indexOf('\n');
        if (nl === -1) { consumed = -1; break; }
        var line = rest.slice(0, nl).replace(/\r$/, '');
        lines.push(line);
        consumed += nl + 1;
        rest = rest.slice(nl + 1);
        done = /^\d{3} /.test(line);
      }
      if (consumed === -1) break;
      buf = buf.slice(consumed);
      var w = waiters.shift();
      var code = parseInt((lines[lines.length - 1] || '').slice(0, 3), 10) || 0;
      w.resolve({ code: code, lines: lines });
    }
    if (closed && waiters.length) {
      while (waiters.length) waiters.shift().reject(lastError || new Error('SMTP 连接已关闭'));
    }
  }

  return {
    read: function (timeoutMs) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          var i = waiters.findIndex(function (w) { return w.reject === reject; });
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('SMTP 响应超时（' + timeoutMs + 'ms）'));
        }, timeoutMs || 15000);
        waiters.push({
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        });
        drain();
      });
    },
    write: function (s) { socket.write(s); },
    close: function () { try { socket.end(); } catch (e) { /* ignore */ } }
  };
}

function expect(session, okCodes, step) {
  return session.read().then(function (r) {
    if (okCodes.indexOf(r.code) === -1) {
      // 失败阶段与服务商响应码一并返回，便于运维定位（不回显任何凭据）
      var err = new Error('SMTP ' + step + ' 失败：' + r.lines.join(' | '));
      err.stage = step;
      err.smtpCode = r.code;
      throw err;
    }
    return r;
  });
}

function connect(cfg) {
  return new Promise(function (resolve, reject) {
    var opts = { host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized };
    var socket = cfg.secure
      ? tls.connect(opts, function () { resolve(socket); })
      : net.connect({ host: cfg.host, port: cfg.port }, function () { resolve(socket); });
    socket.setTimeout(20000, function () { socket.destroy(new Error('SMTP 连接超时')); });
    socket.once('error', reject);
  });
}

function upgradeTls(socket, cfg) {
  return new Promise(function (resolve, reject) {
    var s = tls.connect({ socket: socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized }, function () {
      resolve(s);
    });
    s.once('error', reject);
  });
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

function wrap76(b64str) {
  var out = [];
  for (var i = 0; i < b64str.length; i += 76) out.push(b64str.slice(i, i + 76));
  return out.join('\r\n');
}

function buildMessage(cfg, to, subject, text) {
  var date = new Date().toUTCString();
  var fromAddr = cfg.from;
  var m = /<([^>]+)>/.exec(cfg.from);
  if (m) fromAddr = m[1];
  return [
    'From: ' + cfg.from,
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'Date: ' + date,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@' + fromAddr.split('@')[1] + '>',
    '',
    wrap76(b64(text)),
    ''
  ].join('\r\n');
}

// 发送一封纯文本邮件。
// 成功 resolve：{ ok, accepted, code, stage, host, port, to, elapsedMs }
//   —— accepted=true 只代表「邮件服务商在 DATA 结束后返回 2xx，已接受该邮件」，
//      不等同于收件人收件箱已收到（可能被判垃圾邮件或后续退信），调用方不得夸大为「已送达」。
// 失败 reject：Error，带 stage（greeting/EHLO/STARTTLS/AUTH LOGIN/AUTH USER/AUTH PASS/
//   MAIL FROM/RCPT TO/DATA/DATA body）与 smtpCode（服务商响应码，可能为 null）。
// 只做「连接 + EHLO(+STARTTLS) + AUTH 登录」握手，不发信。
// 用于在管理员录入凭据后立刻验证 SMTP 主机/端口/账号/授权码是否正确。
// 成功 resolve：{ ok, authenticated, code, stage:'AUTH PASS', host, port, secure, elapsedMs }
// 失败 reject：Error，带 stage 与 smtpCode（不回显任何凭据）。
function verifyAuth(cfg) {
  cfg = cfg || loadConfig();
  if (!cfg || !cfg.configured) {
    var e0 = new Error('邮件服务未配置：' + ((cfg && cfg.reason) || '缺少 SMTP 主机/端口'));
    e0.stage = 'config';
    e0.smtpCode = null;
    return Promise.reject(e0);
  }
  if (!cfg.user || !cfg.pass) {
    var e1 = new Error('缺少 SMTP 账号或授权码，无法完成身份认证');
    e1.stage = 'config';
    e1.smtpCode = null;
    return Promise.reject(e1);
  }
  var started = Date.now();
  return connect(cfg).then(function (socket) {
    var session = createSession(socket);
    return expect(session, [220], 'greeting')
      .then(function () {
        session.write('EHLO research-aid\r\n');
        return expect(session, [250], 'EHLO');
      })
      .then(function (r) {
        var supportsStartTls = r.lines.join('\n').toUpperCase().indexOf('STARTTLS') >= 0;
        if (!cfg.secure && supportsStartTls) {
          session.write('STARTTLS\r\n');
          return expect(session, [220], 'STARTTLS').then(function () {
            return upgradeTls(socket, cfg);
          }).then(function (tlsSocket) {
            session = createSession(tlsSocket);
            session.write('EHLO research-aid\r\n');
            return expect(session, [250], 'EHLO(TLS)');
          });
        }
        return r;
      })
      .then(function () {
        session.write('AUTH LOGIN\r\n');
        return expect(session, [334], 'AUTH LOGIN')
          .then(function () { session.write(b64(cfg.user) + '\r\n'); return expect(session, [334], 'AUTH USER'); })
          .then(function () { session.write(b64(cfg.pass) + '\r\n'); return expect(session, [235], 'AUTH PASS'); });
      })
      .then(function (r) {
        try { session.write('QUIT\r\n'); session.close(); } catch (e) { /* ignore */ }
        return {
          ok: true,
          authenticated: true,
          code: r.code,
          stage: 'AUTH PASS',
          host: cfg.host,
          port: cfg.port,
          secure: !!cfg.secure,
          elapsedMs: Date.now() - started
        };
      })
      .catch(function (err) {
        try { session.close(); } catch (e) { /* ignore */ }
        throw err;
      });
  }).catch(function (err) {
    if (err && !err.stage) { err.stage = 'connect'; err.smtpCode = null; }
    throw err;
  });
}

function sendMail(opts) {
  opts = opts || {};
  // 允许调用方传入从云端凭据库取回的配置（覆盖本地文件），便于凭据不落盘
  var cfg = opts.smtp || loadConfig();
  if (!cfg.configured) {
    var e0 = new Error('邮件服务未配置：' + cfg.reason);
    e0.stage = 'config';
    e0.smtpCode = null;
    return Promise.reject(e0);
  }
  var to = String(opts.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    var e1 = new Error('收件人邮箱不合法');
    e1.stage = 'recipient';
    e1.smtpCode = null;
    return Promise.reject(e1);
  }
  var started = Date.now();

  return connect(cfg).then(function (socket) {
    var session = createSession(socket);
    return expect(session, [220], 'greeting')
      .then(function () {
        session.write('EHLO research-aid\r\n');
        return expect(session, [250], 'EHLO');
      })
      .then(function (r) {
        var supportsStartTls = r.lines.join('\n').toUpperCase().indexOf('STARTTLS') >= 0;
        if (!cfg.secure && supportsStartTls) {
          session.write('STARTTLS\r\n');
          return expect(session, [220], 'STARTTLS').then(function () {
            return upgradeTls(socket, cfg);
          }).then(function (tlsSocket) {
            session = createSession(tlsSocket);
            session.write('EHLO research-aid\r\n');
            return expect(session, [250], 'EHLO(TLS)');
          });
        }
        return r;
      })
      .then(function () {
        if (!cfg.user) return null;
        session.write('AUTH LOGIN\r\n');
        return expect(session, [334], 'AUTH LOGIN')
          .then(function () { session.write(b64(cfg.user) + '\r\n'); return expect(session, [334], 'AUTH USER'); })
          .then(function () { session.write(b64(cfg.pass) + '\r\n'); return expect(session, [235], 'AUTH PASS'); });
      })
      .then(function () {
        var fromAddr = /<([^>]+)>/.exec(cfg.from);
        session.write('MAIL FROM:<' + (fromAddr ? fromAddr[1] : cfg.from) + '>\r\n');
        return expect(session, [250], 'MAIL FROM');
      })
      .then(function () { session.write('RCPT TO:<' + to + '>\r\n'); return expect(session, [250, 251], 'RCPT TO'); })
      .then(function () { session.write('DATA\r\n'); return expect(session, [354], 'DATA'); })
      .then(function () {
        session.write(buildMessage(cfg, to, opts.subject || '科研互助平台通知', opts.text || '') + '\r\n.\r\n');
        return expect(session, [250], 'DATA body');
      })
      .then(function (r) {
        session.write('QUIT\r\n');
        session.close();
        return {
          ok: true,
          accepted: true,
          code: r.code,
          stage: 'DATA body',
          host: cfg.host,
          port: cfg.port,
          to: to,
          elapsedMs: Date.now() - started
        };
      })
      .catch(function (err) {
        session.close();
        throw err;
      });
  }).catch(function (err) {
    // 连接阶段（TCP/TLS 握手、超时）失败时补上失败阶段，便于结构化日志定位
    if (err && !err.stage) { err.stage = 'connect'; err.smtpCode = null; }
    throw err;
  });
}

module.exports = {
  loadConfig: loadConfig,
  resetConfigCache: resetConfigCache,
  sendMail: sendMail,
  verifyAuth: verifyAuth
};
