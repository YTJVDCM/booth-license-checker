(async () => {
  'use strict';

  // ── ブラウザ API ─────────────────────────────────────────────────
  // Firefox: browser.runtime.sendMessage は Promise をネイティブ返却する
  // Chrome:  chrome.runtime.sendMessage (MV3) は callback 省略時に Promise を返す
  const extRuntime = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;
  const sendExtMessage = (msg) => extRuntime.sendMessage(msg);

  // ── 定数 ───────────────────────────────────────────────────────────

  const BANNER_ID = 'booth-license-checker-banner';

  const OPTIONAL_HOSTNAMES = new Set([
    'drive.google.com', 'drive.usercontent.google.com', 'docs.google.com',
    'www.dropbox.com', 'dl.dropboxusercontent.com',
  ]);

  // VN3ライセンス利用規約ジェネレータが生成した文書末尾のフッター文を検出する正規表現
  // 照合前に空白を除去するため \s* は不要
  const VN3_FOOTER_RE = /この利用規約は.{0,10}VN3ライセンスVer\.?(?<specVersion>[\d.]+).{0,80}?VN3ライセンス利用規約ジェネレータVer\.?(?<genVersion>[\d.]+).{0,120}?によって作成されました/;

  // ── 設定の読み込み ─────────────────────────────────────────────────

  const settings = await chrome.storage.sync.get({
    enabledConditions: [],
    acceptedChoices: {},
    enabled: true,
    onlyVRChat: true,
  });

  if (!settings.enabled) return;

  if (settings.onlyVRChat && !hasVRChatTag()) return;

  // ── ライセンスセクション内のリンクを収集 ────────────────────────────

  const pageText = extractProductText();
  if (pageText === null) return;
  const licenseLinks = await extractLicenseLinks(pageText);

  if (licenseLinks.length === 0) {
    showUndetectedBadge();
    return;
  }

  // ── バナー（ローディング状態）を先に挿入 ────────────────────────────

  showBanner({ status: 'loading', links: licenseLinks });

  // ── Drive フォルダ URL を個別ファイル URL に展開 ────────────────────

  const expandedLinks = await expandDriveFolderLinks(licenseLinks);

  // ── 各リンクから PDF を取得してパース ─────────────────────────────

  let parseResult = null;
  let usedUrl = null;
  let pdfIsImageBased = false;
  let lastError = null;

  let bestMatchCount = -1;

  for (const url of expandedLinks) {
    try {
      let text;
      if (isGoogleDocsUrl(url)) {
        text = await fetchGoogleDocsText(url);
      } else {
        const result = await fetchPdfText(url);
        if (result.empty) {
          // PDF は取得できたがテキストがない（画像形式の PDF）
          pdfIsImageBased = true;
          if (!usedUrl) usedUrl = url;
          continue;
        }
        text = result.text;
      }
      if (text && text.length > 50) {
        const candidate = parseLicenseText(text);
        if (!candidate.isGeneratorDoc) continue;
        const matchCount = [...candidate.conditions.values()].filter(v => v !== -1).length;
        if (matchCount > bestMatchCount || !parseResult) {
          bestMatchCount = matchCount;
          parseResult = candidate;
          usedUrl = url;
          if (matchCount === VN3_OPTIONS.length) break;
        }
      } else {
        // テキストが空または短すぎる
        pdfIsImageBased = true;
        if (!usedUrl) usedUrl = url;
      }
    } catch (e) {
      lastError = e;
    }
  }

  // VN3 ライセンス文書として解析できたリンクが 1 つでもあれば、他のリンクの
  // アクセスエラー（host_permissions 外など）に関わらず解析結果を優先して表示する
  if (parseResult) {
    showBanner({ status: 'done', parseResult: parseResult.conditions, specialNotes: parseResult.specialNotes, isGeneratorDoc: parseResult.isGeneratorDoc, enabledConditions: settings.enabledConditions, acceptedChoices: settings.acceptedChoices, pdfUrl: usedUrl, links: licenseLinks });
    return;
  }

  if (pdfIsImageBased) {
    showBanner({ status: 'image_pdf', links: licenseLinks, pdfUrl: usedUrl });
    return;
  }

  const permissionMissing = hasOptionalPermissionLink(licenseLinks);
  showBanner({ status: 'fetch_failed', links: licenseLinks, permissionMissing });

  function hasOptionalPermissionLink(links) {
    return links.some(url => {
      try { return OPTIONAL_HOSTNAMES.has(new URL(url).hostname); } catch { return false; }
    });
  }

  function isDriveFolderUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname === 'drive.google.com' && /^\/drive\/folders\//.test(u.pathname);
    } catch {
      return false;
    }
  }

  function isGoogleDocsUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname === 'docs.google.com' && /^\/document\/d\//.test(u.pathname);
    } catch {
      return false;
    }
  }

  async function expandDriveFolderLinks(links) {
    const expanded = [];
    for (const url of links) {
      if (!isDriveFolderUrl(url)) {
        expanded.push(url);
        continue;
      }
      try {
        const response = await sendExtMessage({ type: 'RESOLVE_DRIVE_FOLDER', url });
        if (!response || !response.ok) {
          throw new Error(response?.error || 'unknown resolve error');
        }
        expanded.push(...response.urls);
      } catch (_e) {
        expanded.push(url); // 解決失敗 → 元の URL を保持（手動確認フォールバック）
      }
    }
    return expanded;
  }

  // ════════════════════════════════════════════════════════════════════
  // PDF テキスト取得（バックグラウンドで fetch + pdf.js パースを実行）
  // ════════════════════════════════════════════════════════════════════

  async function fetchPdfText(url) {
    const response = await sendExtMessage({ type: 'FETCH_PDF_TEXT', url });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown fetch error');
    }
    return { text: response.text, empty: response.empty };
  }

  async function fetchGoogleDocsText(url) {
    const response = await sendExtMessage({ type: 'FETCH_GDOCS_TEXT', url });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'unknown gdocs fetch error');
    }
    return response.text;
  }


  // ════════════════════════════════════════════════════════════════════
  // VN3 条件パース
  // ════════════════════════════════════════════════════════════════════

  function detectVN3Footer(text) {
    const tail = text.length > 800 ? text.slice(-800) : text;
    const normalized = tail.replace(/\s/g, '');
    const m = VN3_FOOTER_RE.exec(normalized);
    if (!m) return { found: false, specVersion: null, genVersion: null };
    return {
      found: true,
      specVersion: m.groups.specVersion ?? null,
      genVersion: m.groups.genVersion ?? null,
    };
  }

  function parseLicenseText(text) {
    const result = new Map();

    const footerInfo = detectVN3Footer(text);

    // 個別条件セクション以降を検索対象にする
    // 「個別条件」は基本条項・個別条件双方の文面中に出現するが、見出しとしての「個別条件」は
    // pdf.js のアイテム結合により前後が空白で囲まれた形で現れる（文中では隣接する日本語文字がある）
    // 最後の一致を使うことで目次など前半の見出し相当の出現も除外する
    const headingRe = /(?<!\S)個別条件(?!\S)/g;
    let headingMatch, lastHeadingMatch;
    while ((headingMatch = headingRe.exec(text)) !== null) {
      lastHeadingMatch = headingMatch;
    }
    const searchText = lastHeadingMatch ? text.slice(lastHeadingMatch.index) : text;

    // [A-W]. パターンでオプションセクションの境界を検出
    // VN3 文書の個別条件は「A. タイトル\n選択値」の形式
    const boundaries = [];
    // pdf.js はページ境界でアイテム分割が変わり "G ." のように
    // 文字と句読点の間にスペースが入る場合があるため \s? で吸収する
    const re = /(?<![A-Za-z])([A-W])\s?[.．]\s/g;
    let m;
    while ((m = re.exec(searchText)) !== null) {
      boundaries.push({ letter: m[1], pos: m.index });
    }

    // 各セクション（次の境界まで）を分類
    for (let i = 0; i < boundaries.length; i++) {
      const { letter, pos } = boundaries[i];
      const nextPos = i + 1 < boundaries.length ? boundaries[i + 1].pos : searchText.length;
      const sectionText = searchText.slice(pos, nextPos);
      result.set(letter, classifySection(letter, sectionText));
    }

    // 検出されなかったオプションは -1 (unknown)
    for (const opt of VN3_OPTIONS) {
      if (!result.has(opt.id)) result.set(opt.id, -1);
    }

    return {
      conditions: result,
      isGeneratorDoc: footerInfo.found,
      specVersion: footerInfo.specVersion,
      genVersion: footerInfo.genVersion,
      specialNotes: extractSpecialNotes(searchText),
    };
  }

  function extractSpecialNotes(text) {
    // 個別条件の検出と同様に、前後が非空白文字でない（見出しとして孤立している）
    // 「特記事項」のみを検出する。本文中に「特記事項」が含まれる場合の誤拾いを防ぐ。
    const headingRe = /(?<!\S)特記事項(?!\S)/g;
    let headingMatch, lastHeadingMatch;
    while ((headingMatch = headingRe.exec(text)) !== null) {
      lastHeadingMatch = headingMatch;
    }
    if (!lastHeadingMatch) return null;

    const idx = lastHeadingMatch.index;
    const afterHeading = text.slice(idx + 4).trim();

    // pdf.js はページ境界でスペースを挿入するため、空白除去後に終端を検索し
    // 元テキスト上の位置にマップバックする
    // 終端候補: フッター、または特記事項の次の節（権利者情報など）
    const normalized = afterHeading.replace(/\s/g, '');
    const END_MARKERS = ['この利用規約は', '権利者および権利者への問い合わせ先'];
    const candidates = END_MARKERS.map(m => normalized.indexOf(m)).filter(p => p >= 0);
    const footerIdxNorm = candidates.length > 0 ? Math.min(...candidates) : -1;

    let content;
    if (footerIdxNorm >= 0) {
      let normCount = 0;
      let origIdx = 0;
      while (origIdx < afterHeading.length && normCount < footerIdxNorm) {
        if (!/\s/.test(afterHeading[origIdx])) normCount++;
        origIdx++;
      }
      content = afterHeading.slice(0, origIdx);
    } else {
      content = afterHeading;
    }

    // 末尾に節番号 ("4." / "４．" など、半角・全角を問わず) が残る場合は除去する
    const trimmed = cleanPdfText(content.trim().replace(/\s*[\d０-９]+[.．]\s*$/, '').trim());
    if (!trimmed || /^[\s　]*なし[\s　]*$/.test(trimmed)) return null;
    return trimmed;
  }

  function cleanPdfText(text) {
    return text
      .replace(/[^\S\n]+/g, ' ')                          // 連続スペースを1つに圧縮（改行は保持）
      .replace(/ (?=[　-鿿＀-￯])/g, '')  // 日本語文字の直前のスペースを除去
      .replace(/(?<=[　-鿿＀-￯]) /g, '') // 日本語文字の直後のスペースを除去
      .replace(/\n{3,}/g, '\n\n')                         // 3行以上の連続改行を2行に正規化
      .trim();
  }

  function classifySection(letter, text) {
    const option = VN3_OPTIONS.find(o => o.id === letter);
    if (!option) return -1;
    // matchText が長い（具体的な）ものを先に検査して部分一致の誤検出を防ぐ
    const byLength = option.choices
      .map((c, i) => ({ matchText: c.matchText, i }))
      .sort((a, b) => b.matchText.length - a.matchText.length);
    for (const { matchText, i } of byLength) {
      if (text.includes(matchText)) return i;
    }
    return -1;
  }

  async function extractLicenseLinks(text) {
    return (await createRuleBasedExtractor().extractLinks(text)).map(c => c.url);
  }

  function hasVRChatTag() {
    const main = document.querySelector('main[role="main"]');
    if (!main) return false;
    const BADGE_SRC = 'https://asset.booth.pm/static-images/shops/badges/vrchat.png';
    const article = main.querySelector('article');
    if (article) {
      return !!article.querySelector(`header img[src="${BADGE_SRC}"]`);
    }
    return !!main.querySelector(`header img[src="${BADGE_SRC}"]`);
  }

  function extractProductText() {
    const main = document.querySelector('main[role="main"]');
    if (!main) return null;

    const article = main.querySelector('article');
    const parts = [];

    if (article) {
      const name = article.querySelector('header h2');
      if (name) parts.push(name.innerText);

      const mainInfo = article.querySelector('section.main-info-column');
      if (mainInfo) parts.push(mainInfo.innerText);

      article.querySelectorAll('section.shop__text').forEach(sec => {
        const h = sec.querySelector('h2');
        const p = sec.querySelector('p');
        if (h) parts.push(h.innerText);
        if (p) parts.push(p.innerText);
      });
    } else {
      const name = main.querySelector('header h2');
      if (name) parts.push(name.innerText);

      const desc = main.querySelector('div.main-info-column div.description');
      if (desc) parts.push(desc.innerText);

      main.querySelectorAll('div.main-info-column section.shop__text').forEach(sec => {
        const h = sec.querySelector('h2');
        const p = sec.querySelector('p');
        if (h) parts.push(h.innerText);
        if (p) parts.push(p.innerText);
      });
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // ════════════════════════════════════════════════════════════════════
  // バナー表示
  // ════════════════════════════════════════════════════════════════════

  function getInsertTarget() {
    const selectors = [
      '.market-item-detail',
      '[class*="item-detail"]',
      '[class*="market-item"]',
      'main article',
      'main section',
      'main',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  function showUndetectedBadge() {
    removeBanner();
    const badge = document.createElement('div');
    badge.id = BANNER_ID;
    badge.className = 'vn3-badge vn3-badge--undetected';
    badge.innerHTML = `
      <span class="vn3-badge__icon">🔍</span>
      <span class="vn3-badge__text">BOOTH License Checker: このページで VN3 ライセンスが検出されませんでした</span>
      <button class="vn3-close" aria-label="閉じる">✕</button>
    `;
    badge.querySelector('.vn3-close').addEventListener('click', removeBanner);
    insertBanner(badge);
  }

  function showBanner({ status, parseResult, specialNotes = null, isGeneratorDoc = false, enabledConditions = [], acceptedChoices = {}, pdfUrl, links = [], permissionMissing = false }) {
    removeBanner();
    const banner = document.createElement('div');
    banner.id = BANNER_ID;

    if (status === 'loading') {
      banner.className = 'vn3-banner vn3-banner--loading';
      banner.innerHTML = `
        <div class="vn3-banner__header">
          <span class="vn3-banner__icon">⏳</span>
          <span class="vn3-banner__title">BOOTH License Checker: ライセンス文書を読み込み中…</span>
          <button class="vn3-close" aria-label="閉じる">✕</button>
        </div>
      `;
    } else if (status === 'fetch_failed') {
      banner.className = 'vn3-banner vn3-banner--warn';
      const permissionHint = permissionMissing
        ? `<p>Google Drive や Dropbox へのアクセス許可が有効になっていない可能性があります。<button class="vn3-link-btn" id="vn3-open-options">オプションページ</button>から許可を有効にすると自動取得できる場合があります。</p>`
        : '';
      banner.innerHTML = `
        <div class="vn3-banner__header">
          <span class="vn3-banner__icon">⚠️</span>
          <span class="vn3-banner__title">BOOTH License Checker: ライセンス文書を取得できませんでした</span>
          <button class="vn3-close" aria-label="閉じる">✕</button>
        </div>
        <div class="vn3-banner__body">
          <p>ライセンス文書の内容を手動でご確認ください。</p>
          ${permissionHint}
        </div>
      `;
      if (permissionMissing) {
        banner.querySelector('#vn3-open-options').addEventListener('click', () => {
          sendExtMessage({ type: 'OPEN_OPTIONS' });
        });
      }
    } else if (status === 'image_pdf') {
      banner.className = 'vn3-banner vn3-banner--warn';
      const pdfLinkHtml = pdfUrl
        ? `<a class="vn3-link" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener">ライセンス文書を開く ↗</a>`
        : '';
      banner.innerHTML = `
        <div class="vn3-banner__header">
          <span class="vn3-banner__icon">⚠️</span>
          <span class="vn3-banner__title">BOOTH License Checker: ライセンス文書が画像形式のため自動解析できません</span>
          <button class="vn3-close" aria-label="閉じる">✕</button>
        </div>
        <div class="vn3-banner__body">
          <p>このライセンス文書はテキストを含まない画像形式の PDF です。内容を手動でご確認ください。${pdfLinkHtml ? ' ' + pdfLinkHtml : ''}</p>
        </div>
      `;
    } else if (status === 'done') {
      const checkedIds = VN3_OPTIONS.map(o => o.id)
        .filter(id => enabledConditions.includes(id));
      const problemIds = checkedIds.filter(id => {
        const idx = parseResult.get(id);
        if (idx === undefined || idx === -1) return true;
        const option = VN3_OPTIONS.find(o => o.id === id);
        const matchText = option?.choices[idx]?.matchText;
        const accepted = acceptedChoices[id] ?? [];
        return !matchText || !accepted.includes(matchText);
      });
      const hasProblem = problemIds.length > 0;
      banner.className = `vn3-banner ${hasProblem ? 'vn3-banner--error' : 'vn3-banner--ok'}`;

      const headerIcon = hasProblem ? '⚠️' : '✅';
      const headerTitle = hasProblem
        ? `BOOTH License Checker: ${problemIds.length} 件の条件が許容範囲外です`
        : 'BOOTH License Checker: 全ての設定条件が許容範囲内です';

      const STATUS_INFO = {
        'permitted':      { icon: '✓', cls: 'permitted' },
        'conditional':    { icon: '~', cls: 'conditional' },
        'not-permitted':  { icon: '✗', cls: 'denied' },
        'not-applicable': { icon: '−', cls: 'na' },
        'contact':        { icon: '!', cls: 'contact' },
      };

      const rowsHtml = checkedIds.map(id => {
        const option = VN3_OPTIONS.find(o => o.id === id);
        if (!option) return '';
        const idx = parseResult.get(id);
        const choice = (idx !== undefined && idx !== -1) ? option.choices[idx] : null;
        const choiceType = choice?.type ?? 'unknown';
        const accepted = acceptedChoices[id] ?? [];
        const isOk = !!choice && accepted.includes(choice.matchText);
        const { icon, cls } = STATUS_INFO[choiceType]
          ?? { icon: '?', cls: 'unknown' };
        const statusText = choice?.label ?? '確認できませんでした';
        const rowCls = isOk ? cls : 'denied';
        return `
          <div class="vn3-row vn3-row--${rowCls}">
            <span class="vn3-row__icon">${icon}</span>
            <span class="vn3-row__label">${escapeHtml(option.label)}</span>
            <span class="vn3-row__status">${escapeHtml(statusText)}</span>
          </div>
        `;
      }).join('');

      const disclaimerHtml = `<p class="vn3-disclaimer">※ この要約は自動解析によるものです。内容が正確でない場合があります。購入前にオリジナルのライセンス文書を必ずご確認ください。</p>`;

      const specialNotesHtml = specialNotes
        ? `<div class="vn3-info-box">
            <span class="vn3-info-box__icon">ℹ️</span>
            <div class="vn3-info-box__body">
              <strong class="vn3-info-box__title">特記事項</strong>
              <p class="vn3-info-box__text">${escapeHtml(specialNotes)}</p>
            </div>
          </div>`
        : '';

      banner.innerHTML = `
        <div class="vn3-banner__header">
          <span class="vn3-banner__icon">${headerIcon}</span>
          <span class="vn3-banner__title">${headerTitle}</span>
          <button class="vn3-close" aria-label="閉じる">✕</button>
        </div>
        ${checkedIds.length > 0 ? `<div class="vn3-banner__body">${rowsHtml}</div>` : ''}
        ${specialNotesHtml}
        <div class="vn3-banner__footer">${disclaimerHtml}</div>
      `;

      if (checkedIds.length === 0) {
        const body = document.createElement('div');
        body.className = 'vn3-banner__body';
        body.innerHTML = `<p>許容条件が設定されていません。<a class="vn3-link" href="${extRuntime.getURL('options.html')}" target="_blank">設定ページ</a>で条件を設定してください。</p>`;
        banner.querySelector('.vn3-banner__header')?.insertAdjacentElement('afterend', body);
      }
    }

    banner.querySelectorAll('.vn3-close').forEach(btn => {
      btn.addEventListener('click', removeBanner);
    });

    insertBanner(banner);
  }

  function insertBanner(el) {
    const anchor = document.getElementById('js-item-gift');
    if (anchor) {
      anchor.insertAdjacentElement('afterend', el);
      return;
    }
    const target = getInsertTarget();
    target.insertAdjacentElement('afterbegin', el);
  }

  function removeBanner() {
    document.getElementById(BANNER_ID)?.remove();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname + (u.pathname.length > 30 ? u.pathname.slice(0, 30) + '…' : u.pathname);
    } catch {
      return url.length > 50 ? url.slice(0, 50) + '…' : url;
    }
  }
})();
