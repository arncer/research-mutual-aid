(function () {
  'use strict';
  var pending = null, cooldown = false, busy = false;
  var email = document.getElementById('email'), mode = document.getElementById('mode');
  var code = document.getElementById('code'), send = document.getElementById('send');
  var login = document.getElementById('login'), refresh = document.getElementById('refresh');
  var output = document.getElementById('result');
  function show(text) { output.textContent = text; }
  function controls() { send.disabled = busy || cooldown; login.disabled = busy || !pending; email.disabled = mode.disabled = busy; }
  function invalidate() { pending = null; code.value = ''; controls(); }
  email.addEventListener('input', invalidate); mode.addEventListener('change', invalidate);
  send.addEventListener('click', async function () {
    var account = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) return show('请先填写正确的邮箱。');
    busy = true; pending = null; refresh.hidden = true; controls(); show('正在请求验证码，请稍候……');
    try {
      var result = await APP.cloud.auth.sendOtp({ email: account });
      if (result.error) return show('发送失败：' + result.error.message);
      pending = { email: account, mode: mode.value, verificationId: result.data.verificationId };
      cooldown = true;
      var seconds = 60;
      send.textContent = seconds + ' 秒后可重新获取';
      var timer = setInterval(function () {
        seconds -= 1; send.textContent = seconds > 0 ? seconds + ' 秒后可重新获取' : '③ 获取新的邮箱验证码';
        if (seconds <= 0) { clearInterval(timer); cooldown = false; controls(); }
      }, 1000);
      show('验证码已发送。请自己输入最新验证码，再点击⑤。');
    } catch (e) { show('发送请求失败，请检查网络后重试。'); }
    finally { busy = false; controls(); }
  });
  function safeTrace(trace) {
    return trace.map(function (step) { return step.stage + '：HTTP ' + step.status +
      (step.requestId ? '，请求编号 ' + step.requestId : '') + '，响应 Cookie 数 ' + step.cookieCount +
      (typeof step.sameConnectionAsVerify === 'boolean' ? '，复用核验连接：' + (step.sameConnectionAsVerify ? '是' : '否') : ''); }).join('\n');
  }
  login.addEventListener('click', async function () {
    var attempt = pending, digits = code.value.trim();
    if (!attempt || !/^\d{4,8}$/.test(digits)) return show('请先获取验证码，并输入完整验证码。');
    pending = null; busy = true; controls(); show('正在验证……请勿重复点击。');
    try {
      var session;
      if (attempt.mode === 'browser') {
        var result = await APP.cloud.auth.verifyOtp({ email: attempt.email, verificationId: attempt.verificationId, token: digits, isExistingUser: true });
        if (result.error) return show('普通流程失败：' + result.error.message + '\n这条验证码不再用于其他测试，请重新获取。');
        session = result.data;
      } else {
        var response = await fetch('/api/auth/otp-login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: attempt.email, verificationId: attempt.verificationId, code: digits }) });
        var data = await response.json();
        var trace = data.trace ? safeTrace(data.trace) : '';
        if (!data.ok) return show('服务端流程失败\n阶段：' + data.stage + '\nHTTP：' + (data.status || response.status) +
          '\n错误码：' + (data.code || 'unknown') + '\n说明：' + (data.message || '') + '\n' + trace + '\n请勿重用这条验证码。');
        var raw = data.session;
        if (!raw || !raw.access_token || !raw.refresh_token || !(Number(raw.expires_in) > 0)) return show('签发响应不完整，未写入登录状态。');
        session = { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: Date.now() + Number(raw.expires_in) * 1000,
          user: { id: raw.sub || '', name: raw.name || '', isAnonymous: raw.is_anonymous === true, raw: raw } };
        // Matches this project's bundled SDK SessionStore format; only a verified
        // session returned to this browser is persisted, never an error response.
        localStorage.setItem('workbuddy-cloud.session.' + APP.cloud.config.publishableKey, JSON.stringify(session));
      }
      var me = await APP.cloud.auth.getUser();
      if (me.error || !me.data || !me.data.id) return show('签发成功，但读取当前用户失败：' + ((me.error && me.error.message) || '未返回用户身份'));
      refresh.hidden = false;
      show('本次登录及读取当前用户成功。\n请点击⑥，确认刷新后仍保持登录。');
    } catch (e) { show('检查失败：' + (e.message || '网络或存储异常') + '\n请重新获取验证码后再试。'); }
    finally { code.value = ''; busy = false; controls(); }
  });
  refresh.addEventListener('click', function () { sessionStorage.setItem('login-diagnostic-refresh', '1'); location.reload(); });
  if (sessionStorage.getItem('login-diagnostic-refresh') === '1') {
    sessionStorage.removeItem('login-diagnostic-refresh');
    APP.cloud.auth.getUser().then(function (result) {
      show(result.error || !result.data || !result.data.id ? '刷新后读取用户失败，尚未通过保持登录检查。' : '检查通过：刷新后仍可读取当前用户。可以返回首页使用。');
    }).catch(function () { show('刷新后检查失败，请检查网络。'); });
  }
})();
