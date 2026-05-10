// Service Worker: 外部 PDF の fetch + テキスト抽出を担当（CORS 回避）
// Firefox コンテントスクリプトでは ReadableStream の Xray wrapper 制約により
// pdf.js が動作しないため、バックグラウンドでパースまで行う。

// Chrome MV3 Service Worker: importScripts で読み込む
// Firefox: manifest の background.scripts 配列で先に読み込まれるためスキップ
if (typeof importScripts === 'function') {
  importScripts('lib/pdf.min.js', 'lib/pdf.worker.min.js');
}

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB

// メッセージ処理本体（Promise を返す）
function handleMessage(message) {
  switch (message.type) {
    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return Promise.resolve({ ok: true });
    case 'FETCH_PDF_TEXT':
      return fetchPdfText(message.url)
        .then(result => ({ ok: true, text: result.text, empty: result.empty }))
        .catch(err => ({ ok: false, error: err.message }));
    case 'RESOLVE_DRIVE_FOLDER':
      return resolveDriveFolder(message.url)
        .then(urls => ({ ok: true, urls }))
        .catch(err => ({ ok: false, error: err.message }));
    case 'FETCH_GDOCS_TEXT':
      return fetchGoogleDocsText(message.url)
        .then(text => ({ ok: true, text }))
        .catch(err => ({ ok: false, error: err.message }));
    default:
      return null;
  }
}

// Firefox: browser.runtime.onMessage のリスナーから Promise を直接返すと、
//   その解決値がそのまま sendMessage の戻り値になる（公式サポート）。
// Chrome: sendResponse コールバック + return true でポートを維持する必要がある。
// ブラウザを判定して適切なパターンを使い分ける。
const _isFirefox = (typeof browser !== 'undefined' && !!browser.runtime?.onMessage);
const _onMessage = _isFirefox ? browser.runtime.onMessage : chrome.runtime.onMessage;

if (_isFirefox) {
  // Firefox: Promise を返すパターン
  _onMessage.addListener((message, _sender) => {
    const result = handleMessage(message);
    if (!result) return false;
    return result.catch(err => ({ ok: false, error: err.message }));
  });
} else {
  // Chrome: sendResponse + return true パターン
  _onMessage.addListener((message, _sender, sendResponse) => {
    const result = handleMessage(message);
    if (!result) return false;
    result
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  });
}

async function fetchPdfText(originalUrl) {
  const url = normalizeUrl(originalUrl);
  const response = await fetch(url, {
    credentials: 'omit',
    headers: { 'Accept': 'application/pdf,*/*' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // HTML が返された場合: Google Drive の確認ページ等を処理
  if (contentType.includes('text/html')) {
    const html = await response.text();
    const retryUrl = extractDownloadUrl(html, url);
    if (!retryUrl) {
      // drive.usercontent.google.com から HTML が返った場合はダウンロード制限またはアクセス権限エラー
      if (url.includes('drive.usercontent.google.com')) {
        throw new Error('DRIVE_DOWNLOAD_UNAVAILABLE');
      }
      throw new Error('ダウンロードリンクを HTML から抽出できませんでした。');
    }
    const retryResponse = await fetch(retryUrl, {
      credentials: 'omit',
      headers: { 'Accept': 'application/pdf,*/*' },
    });
    if (!retryResponse.ok) {
      throw new Error(`HTTP ${retryResponse.status} (retry): ${retryUrl}`);
    }
    const retryType = retryResponse.headers.get('content-type') || '';
    if (retryType.includes('text/html')) {
      throw new Error('DRIVE_DOWNLOAD_UNAVAILABLE');
    }
    return await readPdfAndExtractText(retryResponse, retryUrl);
  }

  return await readPdfAndExtractText(response, url);
}

async function readPdfAndExtractText(response, url) {
  // Content-Length で先にサイズチェック（ヘッダがあれば）
  const cl = parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(cl) && cl > MAX_PDF_BYTES) {
    throw new Error(`PDF が大きすぎます (${cl} bytes): ${url}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF が大きすぎます (${buffer.byteLength} bytes): ${url}`);
  }

  // pdf.js でテキスト抽出
  const uint8array = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({ data: uint8array, disableWorker: true }).promise;
  try {
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(item => item.str).join(' ') + '\n';
    }
    // テキストが空または極端に短い場合は画像形式 PDF と判定
    if (!fullText || fullText.trim().length <= 50) {
      return { text: null, empty: true };
    }
    return { text: fullText, empty: false };
  } finally {
    try { await pdf.destroy(); } catch (_e) { /* noop */ }
  }
}

// HTML から実際のダウンロード URL を抽出する（Google Drive 確認ページ対応）
function extractDownloadUrl(html, originalUrl) {
  // Google Drive ウイルススキャン確認ページ:
  // <form id="download-form" action="https://drive.usercontent.google.com/download" ...>
  const formActionMatch = html.match(/action="(https:\/\/drive\.usercontent\.google\.com\/download[^"]+)"/);
  if (formActionMatch) {
    // フォームのフィールドから完全な URL を再構築
    const action = formActionMatch[1].replace(/&amp;/g, '&');
    const fields = {};
    const inputRe = /name="([^"]+)"\s+value="([^"]*)"/g;
    let m;
    while ((m = inputRe.exec(html)) !== null) {
      fields[m[1]] = m[2];
    }
    const params = new URLSearchParams(fields);
    return `${action}?${params.toString()}`;
  }

  // <a> タグに直接ダウンロードリンクが含まれる場合
  const hrefMatch = html.match(/href="(https:\/\/drive\.usercontent\.google\.com\/download[^"]+)"/);
  if (hrefMatch) {
    return hrefMatch[1].replace(/&amp;/g, '&');
  }

  return null;
}

// Google Drive フォルダページから個別ファイルの直接ダウンロード URL を抽出する
async function resolveDriveFolder(folderUrl) {
  const response = await fetch(folderUrl, {
    credentials: 'omit',
    headers: { 'Accept': 'text/html,*/*' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${folderUrl}`);
  }
  const html = await response.text();

  // フォルダ ID を URL から抽出（結果から除外するため）
  const folderIdMatch = folderUrl.match(/folders\/([A-Za-z0-9_-]+)/);
  const folderId = folderIdMatch ? folderIdMatch[1] : '';

  // Google Drive の SPA は /file/d/{id} リンクを初期 HTML に含まない。
  // ファイル ID は JSON 文字列として直接埋め込まれており、
  // 現行の Drive ファイル ID は '1' で始まる 29〜44 文字の英数字 + -_
  const fileIdRe = /"(1[A-Za-z0-9_-]{28,43})"/g;
  const seen = new Set();
  const fileIds = [];
  let m;
  while ((m = fileIdRe.exec(html)) !== null) {
    const id = m[1];
    if (!seen.has(id) && id !== folderId) {
      seen.add(id);
      fileIds.push(id);
    }
  }

  if (fileIds.length === 0) {
    throw new Error('Drive フォルダページからファイル ID を抽出できませんでした。');
  }

  // matchText が日本語のため日本語ファイルを先頭に並べる
  const JAPANESE_RE = /(?:ja|JP|日本語|japanese)/i;
  const jaIds = [];
  const otherIds = [];
  for (const id of fileIds) {
    const idPos = html.indexOf(id);
    const context = idPos >= 0 ? html.slice(Math.max(0, idPos - 300), idPos + 300) : '';
    if (JAPANESE_RE.test(context)) {
      jaIds.push(id);
    } else {
      otherIds.push(id);
    }
  }
  return [...jaIds, ...otherIds].map(
    id => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
  );
}

function extractGoogleDocsId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/document\/d\/([^/]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function fetchGoogleDocsText(originalUrl) {
  const id = extractGoogleDocsId(originalUrl);
  if (!id) throw new Error('Google ドキュメント ID を抽出できませんでした。');

  const exportUrl = `https://docs.google.com/document/d/${id}/export?format=txt`;
  const response = await fetch(exportUrl, {
    credentials: 'omit',
    headers: { 'Accept': 'text/plain,*/*' },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('GDOCS_PRIVATE');
    }
    throw new Error(`HTTP ${response.status}: ${exportUrl}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    // 非公開ドキュメントの場合 Google はログインページ（HTML）を 200 で返す
    throw new Error('GDOCS_PRIVATE');
  }

  return await response.text();
}

// 各ホスティングサービスに応じて直接ダウンロード URL に変換する
function normalizeUrl(url) {
  try {
    const u = new URL(url);

    // Google Drive: /file/d/{id}/view → drive.usercontent.google.com 直接ダウンロード
    // （drive.google.com/uc は 303 リダイレクトを返すため usercontent を直接使用）
    const driveMatch = u.pathname.match(/\/file\/d\/([^/]+)/);
    if (u.hostname === 'drive.google.com' && driveMatch) {
      return `https://drive.usercontent.google.com/download?id=${driveMatch[1]}&export=download&confirm=t`;
    }

    // Google Drive 共有リンク: /open?id={id}
    if (u.hostname === 'drive.google.com' && u.searchParams.get('id')) {
      const id = u.searchParams.get('id');
      return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    }

    // Dropbox: ?dl=0 → ?dl=1 / www.dropbox.com → dl.dropboxusercontent.com
    if (u.hostname === 'www.dropbox.com' || u.hostname === 'dropbox.com') {
      u.searchParams.set('dl', '1');
      return u.toString();
    }

    // GitHub Gist: gist.github.com/{user}/{id} → raw URL
    const gistMatch = u.pathname.match(/^\/([^/]+)\/([a-f0-9]+)$/);
    if (u.hostname === 'gist.github.com' && gistMatch) {
      return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
    }

    // OneDrive 短縮リンク (1drv.ms) はリダイレクト先をそのまま fetch
    // （fetch が自動的にリダイレクトを追う）

    return url;
  } catch {
    return url;
  }
}
