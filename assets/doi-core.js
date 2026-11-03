/* 科研互助平台 - DOI 规范化与文献元数据解析（共享模块）
 * 浏览器：作为 window.DOI_CORE 使用（在 app.js 之前加载）。
 * Node.js：server.js 通过 require('./assets/doi-core.js') 使用。
 * 该模块不依赖 DOM / window，保证浏览器与服务器两端逻辑完全一致。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DOI_CORE = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---- DOI 规范化（查询 / 查重 / 保存统一复用）----
  // 只移除明确的输入格式前缀与外围引用字符，不删除 DOI 内部字符：
  //   兼容 10.xxxx/xxxxx、doi: 前缀、https?://(dx.)doi.org/ 前缀、首尾空白、
  //   URL 编码、外围引号/书名号/尖括号、末尾引用标点（句号逗号分号等）、大小写差异。
  function stripUnbalancedCloser(s, open, close) {
    var o = s.split(open).length - 1, c = s.split(close).length - 1;
    while (c > o && s.slice(-1) === close) { s = s.slice(0, -1); c--; }
    return s;
  }

  function normalizeDoi(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    // 外围引号 / 尖括号 / 中文书名号
    s = s.replace(/^[<\["'（【「『]+/, '').trim();
    s = s.replace(/^doi:\s*/i, '');
    s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    s = s.replace(/^(dx\.)?doi\.org\//i, '');
    s = s.trim();
    try { s = decodeURIComponent(s); } catch (e) { /* 保留原样 */ }
    // 复制参考文献时误带的末尾引用标点（不影响 DOI 内部字符）
    s = s.replace(/[\s.,;:，。；、'"’”>]+$/, '');
    // 末尾不配对的 ) ] }（如 "…00090-2)." 或 Markdown 链接），配对的括号保留
    s = stripUnbalancedCloser(s, '(', ')');
    s = stripUnbalancedCloser(s, '[', ']');
    s = stripUnbalancedCloser(s, '{', '}');
    s = s.toLowerCase();
    if (!/^10\.\d{4,}\/\S+$/.test(s)) return null;
    return s;
  }

  // ---- 结构化错误：kind 严格区分 not_found / timeout / http / network / empty / unavailable ----
  function doiError(kind, message, extra) {
    var e = new Error(message);
    e.kind = kind;
    if (extra) { for (var k in extra) e[k] = extra[k]; }
    return e;
  }

  // Crossref 等来源的文本字段可能带 HTML 实体（如 &amp;），入库前统一解码
  function decodeEntities(s) {
    if (!s) return s;
    return String(s)
      .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  var WORK_TYPE_MAP = {
    'journal-article': '期刊论文', 'proceedings-article': '会议论文', 'book-chapter': '图书章节',
    'preprint': '预印本', 'posted-content': '预印本', 'dataset': '数据集', 'book': '图书',
    'monograph': '专著', 'report': '报告', 'dissertation': '学位论文', 'standard': '标准',
    'article-journal': '期刊论文', 'paper-conference': '会议论文', 'chapter': '图书章节',
    'article': '期刊论文', 'thesis': '学位论文'
  };

  var SOURCE_LABEL = { crossref: 'Crossref', datacite: 'DataCite', openalex: 'OpenAlex', doicn: 'doi.org 内容协商', cnki: 'CNKI DOI 官方解析页' };

  function parseCnkiResolution(data, expectedDoi) {
    var html = data && data.html;
    if (typeof html !== 'string') return null;
    var fields = {};
    var cells = /<td\b[^>]*>\s*<label\b[^>]*>([\s\S]*?)<\/label>([\s\S]*?)<\/td>/gi;
    var match;
    function text(value) { return decodeEntities(value.replace(/<[^>]*>/g, '')).trim(); }
    while ((match = cells.exec(html))) {
      fields[text(match[1]).replace(/[：:\s]/g, '')] = text(match[2]);
    }
    var doi = normalizeDoi(fields['DOI码']);
    if (!doi || doi !== normalizeDoi(expectedDoi) || !fields['题名']) return null;
    return {
      doi: doi, title: fields['题名'], authors: (fields['作者'] || '').replace(/[;；]+$/, ''),
      journal: fields['来源'] || '', publisher: fields['出版机构'] || '',
      published_year: /^\d{4}$/.test(fields['出版年'] || '') ? Number(fields['出版年']) : null,
      volume: null, issue: null, pages: null, issn: null,
      doi_url: 'https://doi.org/' + doi, source_url: 'https://doi.org/' + doi,
      oa_url: '', license: ''
    };
  }

  // Crossref：message 结构（卷 / 期 / 页码 / 文章号 / ISSN / 类型均映射）
  function parseCrossrefMessage(m) {
    if (!m || !m.DOI) return null;
    var authors = '';
    if (Array.isArray(m.author)) {
      authors = m.author.map(function (a) {
        return [a.family, a.given].filter(Boolean).join(' ');
      }).filter(Boolean).join(', ');
    }
    var year = null;
    var dp = (m.issued || m.published || m.created || {})['date-parts'];
    if (Array.isArray(dp) && dp[0]) year = dp[0][0] || null;
    var oaUrl = '';
    if (Array.isArray(m.link)) {
      for (var i = 0; i < m.link.length; i++) {
        if (m.link[i] && m.link[i]['content-type'] === 'application/pdf' && m.link[i].URL) { oaUrl = m.link[i].URL; break; }
      }
    }
    var license = '';
    if (Array.isArray(m.license) && m.license[0] && m.license[0].URL) license = m.license[0].URL;
    var pages = m.page || null;
    if (!pages && m['article-number']) pages = '文章号 ' + m['article-number'];
    return {
      doi: String(m.DOI).toLowerCase(),
      title: decodeEntities((Array.isArray(m.title) && m.title[0]) || ''),
      authors: decodeEntities(authors),
      journal: decodeEntities((Array.isArray(m['container-title']) && m['container-title'][0]) || ''),
      journal_type: WORK_TYPE_MAP[m.type] || '',
      publisher: decodeEntities(m.publisher || ''),
      published_year: year,
      volume: m.volume || '',
      issue: m.issue || '',
      pages: pages || '',
      issn: Array.isArray(m.ISSN) && m.ISSN.length ? m.ISSN.join('，') : '',
      doi_url: m.URL || ('https://doi.org/' + String(m.DOI).toLowerCase()),
      source_url: '',
      oa_url: oaUrl,
      license: license
    };
  }

  // DataCite：data.attributes 结构（container 内是期刊 / 卷期页码）
  function parseDataciteDoi(a) {
    if (!a || !a.doi) return null;
    var authors = '';
    if (Array.isArray(a.creators)) {
      authors = a.creators.map(function (c) {
        if (!c) return '';
        if (c.familyName || c.givenName) return [c.familyName, c.givenName].filter(Boolean).join(' ');
        return c.name || '';
      }).filter(Boolean).join(', ');
    }
    var c = a.container || {};
    var pages = '';
    if (c.firstPage) pages = c.lastPage && c.lastPage !== c.firstPage ? (c.firstPage + '-' + c.lastPage) : c.firstPage;
    var ctype = (a.types && (a.types.citeproc || a.types.bibtex)) || '';
    return {
      doi: String(a.doi).toLowerCase(),
      title: decodeEntities((Array.isArray(a.titles) && a.titles[0] && a.titles[0].title) || ''),
      authors: decodeEntities(authors),
      journal: decodeEntities(c.title || ''),
      journal_type: WORK_TYPE_MAP[ctype] || '',
      publisher: decodeEntities(a.publisher || ''),
      published_year: a.publicationYear || null,
      volume: c.volume || '',
      issue: c.issue || '',
      pages: pages,
      issn: '',
      doi_url: 'https://doi.org/' + String(a.doi).toLowerCase(),
      source_url: a.url || '',
      oa_url: '',
      license: (Array.isArray(a.rightsList) && a.rightsList[0] && a.rightsList[0].rightsUri) || ''
    };
  }

  // OpenAlex：works 结构（期刊名取 primary_location.source.display_name，不用出版社名代替）
  function parseOpenalexWork(w) {
    if (!w || !w.id) return null;
    var src = (w.primary_location && w.primary_location.source) || {};
    var authors = '';
    if (Array.isArray(w.authorships)) {
      authors = w.authorships.map(function (a) {
        return a && a.author && a.author.display_name;
      }).filter(Boolean).join(', ');
    }
    var b = w.biblio || {};
    var pages = '';
    if (b.first_page) pages = b.last_page && b.last_page !== b.first_page ? (b.first_page + '-' + b.last_page) : b.first_page;
    var field = (w.primary_topic && w.primary_topic.field && w.primary_topic.field.display_name) || '';
    var doiRaw = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
    return {
      doi: String(doiRaw || '').toLowerCase(),
      title: decodeEntities(w.display_name || ''),
      authors: decodeEntities(authors),
      journal: decodeEntities(src.display_name || ''),
      journal_type: field ? '学科：' + field : '',
      publisher: decodeEntities(src.host_organization_name || ''),
      published_year: w.publication_year || null,
      volume: b.volume || '',
      issue: b.issue || '',
      pages: pages,
      issn: src.issn_l || (Array.isArray(src.issn) && src.issn[0]) || '',
      doi_url: w.doi || '',
      source_url: (w.primary_location && w.primary_location.landing_page_url) || '',
      oa_url: (w.primary_location && w.primary_location.pdf_url) || '',
      license: (w.primary_location && w.primary_location.license) || ''
    };
  }

  // CSL JSON（doi.org 内容协商，重定向到 Crossref transform / data.crosscite.org）：覆盖所有注册机构的通用兜底来源
  function parseCslJson(c) {
    if (!c || (!c.title && !c.DOI && !c.id)) return null;
    var authors = '';
    if (Array.isArray(c.author)) {
      authors = c.author.map(function (a) {
        if (!a) return '';
        if (a.literal) return a.literal;
        return [a.family, a.given].filter(Boolean).join(' ');
      }).filter(Boolean).join(', ');
    }
    var year = null;
    var dp = (c.issued || {})['date-parts'];
    if (Array.isArray(dp) && dp[0]) year = dp[0][0] || null;
    var doiRaw = c.DOI || String(c.id || '').replace(/^https?:\/\/doi\.org\//i, '');
    return {
      doi: String(doiRaw || '').toLowerCase(),
      title: decodeEntities(c.title || ''),
      authors: decodeEntities(authors),
      journal: decodeEntities(c['container-title'] || ''),
      journal_type: WORK_TYPE_MAP[c.type] || '',
      publisher: decodeEntities(c.publisher || ''),
      published_year: year,
      volume: c.volume || '',
      issue: c.issue || '',
      pages: c.page || '',
      issn: Array.isArray(c.ISSN) ? c.ISSN.join('，') : (c.ISSN || ''),
      doi_url: 'https://doi.org/' + String(doiRaw || '').toLowerCase(),
      source_url: c.URL || '',
      oa_url: '',
      license: ''
    };
  }

  // 各来源的 URL 构造与响应解析（URL 构造按各 API 真实接口格式分别处理，不复用同一函数）
  function sourceDef(name, enc) {
    if (name === 'cnki') {
      return { url: 'https://www.chndoi.org/Resolution/Handler?doi=' + enc, accept: 'text/html',
        parse: function (j) { return parseCnkiResolution(j, decodeURIComponent(enc)); } };
    }
    if (name === 'crossref') {
      // Crossref REST：DOI 整体 URL 编码（斜杠编码为 %2F 是官方推荐形式）
      return { url: 'https://api.crossref.org/works/' + enc, accept: 'application/json',
        parse: function (j) { return parseCrossrefMessage(j && j.message); } };
    }
    if (name === 'datacite') {
      // DataCite REST：/dois/{doi}，DOI 整体 URL 编码
      return { url: 'https://api.datacite.org/dois/' + enc, accept: 'application/json',
        parse: function (j) { return parseDataciteDoi(j && j.data && j.data.attributes); } };
    }
    if (name === 'openalex') {
      // OpenAlex：/works/{doi-url}，作品标识为完整 DOI URL 并整体编码
      return { url: 'https://api.openalex.org/works/https%3A%2F%2Fdoi.org%2F' + enc, accept: 'application/json',
        parse: parseOpenalexWork };
    }
    // doicn：doi.org 内容协商（不是普通 JSON API，必须带 CSL JSON 的 Accept 头），
    // 由 doi.org 302 到对应注册机构的 CSL 服务（api.crossref.org transform / data.crosscite.org）
    return { url: 'https://doi.org/' + enc, accept: 'application/vnd.citationstyles.csl+json',
      parse: parseCslJson };
  }

  // 多来源查询编排：先查 DOI 注册机构决定优先级（Crossref / DataCite），OpenAlex 补充，
  // doi.org 内容协商（覆盖全部注册机构、走不同主机名）作为最后兜底。
  // 单源 404 不代表 DOI 无效；全部 404 才判定未找到；超时 / 5xx / 网络错误归类为暂时不可用。
  // 网络错误与超时自动重试一次（有限重试）。
  // httpGet(url, accept, timeoutMs) 由调用方注入（浏览器 fetch 或 Node fetch），
  // 需 resolve { json, httpStatus, elapsedMs }，reject doiError。
  // 返回 { paper, source, partial, attempts }；失败抛出带 kind 与 attempts 的 Error。
  function lookupPaperMetadata(doi, httpGet, opts) {
    var enc = encodeURIComponent(doi);
    var attempts = [];
    var retryDelayMs = (opts && opts.retryDelayMs) || 800;
    var perSourceTimeout = (opts && opts.timeoutMs) || 12000;

    function run(name) {
      var def = sourceDef(name, enc);
      function once() {
        var started = Date.now();
        return httpGet(def.url, def.accept, perSourceTimeout).then(function (res) {
          attempts.push({ source: name, status: res.httpStatus, ms: res.elapsedMs, result: 'hit' });
          var paper = def.parse(res.json);
          if (!paper || (!paper.title && !paper.doi)) {
            throw doiError('empty', SOURCE_LABEL[name] + ' 返回数据为空');
          }
          return paper;
        }, function (err) {
          attempts.push({ source: name, status: err.httpStatus || err.kind, ms: err.elapsedMs || (Date.now() - started), result: err.kind || 'error' });
          throw err;
        });
      }
      // 网络错误 / 超时自动重试一次
      return once().catch(function (err) {
        if (err && (err.kind === 'network' || err.kind === 'timeout')) {
          return new Promise(function (resolve) { setTimeout(resolve, retryDelayMs); }).then(once);
        }
        throw err;
      });
    }

    // 注册机构查询失败不阻塞：回退到默认顺序
    return httpGet('https://doi.org/ra/' + enc, 'application/json', 6000).then(function (res) {
      var ra = (Array.isArray(res.json) && res.json[0] && res.json[0].RA) || '';
      attempts.push({ source: 'doi.org/ra', status: res.httpStatus, ms: res.elapsedMs, result: ra || 'unknown' });
      if (/cnki/i.test(ra)) return ['cnki', 'crossref', 'datacite', 'openalex', 'doicn'];
      if (/datacite/i.test(ra)) return ['datacite', 'crossref', 'openalex', 'doicn'];
      return ['crossref', 'datacite', 'openalex', 'doicn'];
    }, function (err) {
      attempts.push({ source: 'doi.org/ra', status: err.httpStatus || err.kind, ms: err.elapsedMs, result: 'skipped' });
      return ['crossref', 'datacite', 'openalex', 'doicn'];
    }).then(function (order) {
      var errors = [];
      var chain = Promise.resolve(null);
      order.forEach(function (name) {
        chain = chain.then(function (found) {
          if (found) return found;
          return run(name).then(function (paper) { return { paper: paper, source: name }; },
            function (err) { err.source = name; errors.push(err); return null; });
        });
      });
      return chain.then(function (found) {
        if (found) {
          found.attempts = attempts;
          found.partial = !(found.paper.authors && found.paper.journal && found.paper.published_year);
          return found;
        }
        var allNotFound = errors.length && errors.every(function (e) { return e.kind === 'not_found'; });
        if (allNotFound) {
          throw doiError('not_found',
            '本地数据库和外部文献服务（' + order.map(function (n) { return SOURCE_LABEL[n]; }).join(' / ') + '）均未找到该 DOI 对应的论文。请检查 DOI 是否正确，或改用「没有 DOI？手动填写论文信息」。',
            { attempts: attempts });
        }
        var detail = errors.map(function (e) { return (SOURCE_LABEL[e.source] || '') + e.message; }).filter(Boolean).join('；');
        throw doiError('unavailable',
          '外部文献元数据服务暂时不可用（' + detail + '）。本地数据库中也没有该论文记录。这不是 DOI 无效，请稍后重试，或先手动填写论文信息后直接发布求助。',
          { attempts: attempts });
      });
    });
  }

  return {
    normalizeDoi: normalizeDoi,
    doiError: doiError,
    decodeEntities: decodeEntities,
    WORK_TYPE_MAP: WORK_TYPE_MAP,
    SOURCE_LABEL: SOURCE_LABEL,
    parseCrossrefMessage: parseCrossrefMessage,
    parseDataciteDoi: parseDataciteDoi,
    parseOpenalexWork: parseOpenalexWork,
    parseCslJson: parseCslJson,
    parseCnkiResolution: parseCnkiResolution,
    lookupPaperMetadata: lookupPaperMetadata
  };
});
