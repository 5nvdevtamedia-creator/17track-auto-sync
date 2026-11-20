const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1EWJzWcNn-a6mYnf_M2EZAky4iIgfPJEVy1k8znSFjZo';
const TARGET_GID = process.env.TARGET_GID || '603702674';
const GOOGLE_SHEET_WEBHOOK_URL = (process.env.SHEET_WEBHOOK_URL || '').trim();
const PROXY_URL = (process.env.PROXY_URL || '').trim();

const BATCH_SIZE = 40;
const RETRY_CHUNK_SIZE = 14;
const BATCH_INTERVAL_MS = Math.max(0, Number(process.env.BATCH_INTERVAL_MINUTES || 6)) * 60 * 1000;
const MAX_RUN_MS = Math.max(10, Number(process.env.MAX_RUN_MINUTES || 300)) * 60 * 1000; // Mặc định tối đa 5 giờ/lần (an toàn dưới mức 6 giờ của GitHub Actions)
const PER_ATTEMPT_TIMEOUT_MS = 32 * 1000;

const STATE_DIR = path.join(__dirname, '.state');
const STATE_FILE = path.join(STATE_DIR, 'cursor.json');

const CARD_SELECTOR =
  '.border.bg-card.text-card-foreground.overflow-hidden.transition-shadow.duration-200.rounded-xl.shadow-none';

let anchorGoodCode = process.env.ANCHOR_GOOD_CODE || 'YWBZ2026179935';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidTrackingNumber(val) {
  if (!val) return false;
  const clean = String(val).trim();
  if (!clean) return false;
  if (/^(mã|ma|track|mtrack|tracking|stt|code|no\.?|id)/i.test(clean) && !/\d{4,}/.test(clean)) {
    return false;
  }
  return /^[A-Z0-9]{6,35}$/i.test(clean) && /\d/.test(clean);
}

function deduplicateTrackingList(list) {
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const clean = String(raw || '').trim();
    if (!isValidTrackingNumber(clean)) continue;
    const key = clean.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  }
  return result;
}

function isRealTrackedItem(item) {
  if (!item || item.isQuerying || item.isNotFound || item.isRateLimited) return false;
  if (!item.colC || /^not\s*found\b/i.test(item.colC)) return false;
  return Boolean(
    item.colB ||
      /delivered|in\s*transit|undelivered|pick\s*up|out\s*for|alert|info\s*received|expired/i.test(item.colC)
  );
}

function loadState() {
  if (process.env.RESET_CURSOR === 'true') {
    console.log('🔄 RESET_CURSOR=true -> Bắt đầu lại từ đơn đầu tiên (cursor = 0).');
    return { cursor: 0 };
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (parsed && typeof parsed.cursor === 'number' && parsed.cursor >= 0) {
        return parsed;
      }
    }
  } catch (e) {}
  return { cursor: 0 };
}

function saveState(stateObj) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const payload = {
      ...stateObj,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (e) {
    console.warn('⚠️ Không thể lưu file trạng thái .state/cursor.json:', e.message);
  }
}

async function fetchAllTrackingNumbers() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (GOOGLE_SHEET_WEBHOOK_URL) {
      try {
        const res = await fetch(GOOGLE_SHEET_WEBHOOK_URL);
        const json = await res.json();
        if (json.success && Array.isArray(json.trackingNumbers)) {
          const filtered = deduplicateTrackingList(json.trackingNumbers);
          if (filtered.length > 0) {
            console.log(`📥 Đã đọc ${filtered.length} mã vận đơn hợp lệ từ Apps Script.`);
            return filtered;
          }
        }
      } catch (e) {
        console.warn(`⚠️ Lần ${attempt}: Lỗi đọc Apps Script (${e.message}), thử dự phòng CSV...`);
      }
    }

    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${TARGET_GID}`;
      const res = await fetch(csvUrl);
      if (res.ok) {
        const csvText = await res.text();
        const rawList = csvText
          .split(/\r?\n/)
          .slice(1)
          .map((line) => line.split(',')[0].replace(/^"|"$/g, '').trim());
        const filtered = deduplicateTrackingList(rawList);
        if (filtered.length > 0) {
          console.log(`📥 Đã đọc ${filtered.length} mã vận đơn hợp lệ từ Sheet CSV.`);
          return filtered;
        }
      }
    } catch (e) {}

    if (attempt < 4) await sleep(3000);
  }
  throw new Error('Không thể đọc danh sách Mã track từ Google Sheet.');
}

async function pushBatchToSheet(items, batchIndex, isFinalBatch) {
  if (!GOOGLE_SHEET_WEBHOOK_URL) {
    console.warn('⚠️ Chưa cấu hình biến môi trường SHEET_WEBHOOK_URL -> Bỏ qua bước đẩy lên Sheet.');
    return { success: false, updatedCount: 0 };
  }
  if (!items || items.length === 0) {
    return { success: true, updatedCount: 0 };
  }

  const lastCodeInBatch = items[items.length - 1].trackingNumber;
  const payloadStr = JSON.stringify({
    items,
    batchIndex,
    isFinalBatch,
    lastCodeInBatch,
  });

  for (let retry = 1; retry <= 3; retry++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payloadStr,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        return { success: true, updatedCount: items.length };
      }
    } catch (err) {
      if (retry < 3) {
        await sleep(2000);
      } else {
        console.warn(`⚠️ Không nhận được phản hồi JSON khi đẩy lô ${batchIndex}: ${err.message}`);
      }
    }
  }
  return { success: true, updatedCount: items.length };
}

function parseProxyConfig(proxyUrlStr) {
  if (!proxyUrlStr) return null;
  try {
    const u = new URL(proxyUrlStr.includes('://') ? proxyUrlStr : `http://${proxyUrlStr}`);
    return {
      server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch (e) {
    console.warn('⚠️ PROXY_URL không đúng định dạng (ví dụ http://user:pass@ip:port), sẽ chạy không dùng proxy.');
    return null;
  }
}

async function createConfiguredPage(browser, proxyConfig) {
  const page = await browser.newPage();

  if (proxyConfig && proxyConfig.username) {
    await page.authenticate({
      username: proxyConfig.username,
      password: proxyConfig.password,
    });
  }

  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.hasFocus = () => true;
  });

  return page;
}

async function extractPageData(page, expectedCodes, scrollStep) {
  return page.evaluate(
    ({ cardSel, codes, step }) => {
      const DATE_REGEX = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/;

      // Tự động đóng bảng hướng dẫn 4 bước nếu 17track hiện lên
      try {
        const allButtons = Array.from(document.querySelectorAll('button'));
        for (const btn of allButtons) {
          const txt = (btn.textContent || '').trim();
          if (/^(finish|skip|got it)$/i.test(txt)) {
            btn.click();
            break;
          }
          if (/^next$/i.test(txt)) {
            const modal = btn.closest('div.fixed, div.absolute, [role="dialog"]');
            const closeBtn = modal && modal.querySelector('button svg, .cursor-pointer');
            if (closeBtn) {
              (closeBtn.closest('button') || closeBtn).click();
            } else {
              btn.click();
            }
            break;
          }
        }
      } catch (e) {}

      // Cuộn nhẹ Đầu -> Giữa -> Cuối để kích hoạt render đủ 40 thẻ
      try {
        const allCards = document.querySelectorAll(cardSel);
        if (allCards.length > 5) {
          const targetIndex =
            step % 3 === 0 ? Math.floor(allCards.length / 2) : step % 3 === 1 ? allCards.length - 1 : 0;
          if (allCards[targetIndex]) {
            allCards[targetIndex].scrollIntoView({ behavior: 'instant', block: 'center' });
          }
        }
      } catch (e) {}

      function isExactRateLimitText(text) {
        if (!text) return false;
        const clean = String(text).replace(/\s+/g, ' ').trim();
        if (clean.includes('Your tracking is too frequent, please try again later.')) {
          return true;
        }
        return (
          /(?:your\s+)?tracking\s+is\s+too\s+frequent/i.test(clean) &&
          /please\s+try\s+again\s+later/i.test(clean)
        );
      }

      function evaluateStatus(colCText) {
        if (!colCText) return { isDelivered: false, colD: '' };
        const clean = colCText.trim();
        if (/^delivered\b/i.test(clean)) return { isDelivered: true, colD: 'Delivered' };
        if (/^expired\b/i.test(clean)) return { isDelivered: false, colD: 'Check' };
        const daysMatch = clean.match(/\((\d+)\s*days?\)/i);
        const days = daysMatch ? parseInt(daysMatch[1], 10) : 0;
        if (/^info\s*received\b/i.test(clean)) {
          return { isDelivered: false, colD: days > 10 ? 'Check' : '' };
        }
        if (days > 5) return { isDelivered: false, colD: 'Check' };
        return { isDelivered: false, colD: '' };
      }

      function getPureText(el) {
        if (!el) return '';
        let text = '';
        el.childNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        });
        return (text || el.textContent || '').replace(/\s+/g, ' ').trim();
      }

      const allowedSet =
        Array.isArray(codes) && codes.length > 0
          ? new Set(codes.map((c) => String(c).trim().toUpperCase()))
          : null;

      const cards = Array.from(document.querySelectorAll(cardSel));
      const results = [];
      const pageSpinners = document.querySelectorAll('.animate-spin, .animate-pulse').length;
      let hasDemoCard = false;

      cards.forEach((card) => {
        const firstClosedDiv = card.querySelector(':scope > div:first-child') || card;
        const codeEl = firstClosedDiv.querySelector(
          'span.text-sm.font-medium.truncate[title], .flex.items-center.gap-2.justify-around .flex-1.min-w-0 span.truncate'
        );
        const trackingNumber = codeEl ? (codeEl.getAttribute('title') || codeEl.textContent || '').trim() : '';

        if (/^testnumber/i.test(trackingNumber)) {
          hasDemoCard = true;
          return;
        }
        if (!trackingNumber || /^(mtrack|mã\s*track|tracking)$/i.test(trackingNumber)) return;
        if (allowedSet && !allowedSet.has(trackingNumber.toUpperCase())) return;

        const colBEl = firstClosedDiv.querySelector(
          '.flex-1.min-w-0.px-2.cursor-pointer.text-sm.text-zinc-900 > div:first-child'
        );
        const rawColB = colBEl ? colBEl.textContent.trim() : '';
        const dateMatch = rawColB.match(DATE_REGEX) || firstClosedDiv.textContent.match(DATE_REGEX);
        const colB = dateMatch ? dateMatch[0] : '';

        const colCEl = firstClosedDiv.querySelector(
          '.flex.items-center.gap-2.justify-around .flex-1.min-w-0 .text-sm.text-text-primary.flex.items-center.gap-1, .text-sm.text-text-primary.flex.items-center.gap-1'
        );
        const colC = getPureText(colCEl);

        const isRateLimited = isExactRateLimitText(firstClosedDiv.textContent);
        const hasCardSpinner = Boolean(
          firstClosedDiv.querySelector('.animate-spin, .animate-pulse, [class*="skeleton"], [class*="loading"]')
        );
        const isTextQuerying =
          (!colC && !isRateLimited) ||
          /querying|loading|waiting|searching|processing|translating/i.test(colC) ||
          /querying|loading|waiting|searching|processing|please wait/i.test(rawColB);

        const isNotFound = (/^not\s*found\b/i.test(colC) && !colB) || isRateLimited;
        const isQuerying = !isRateLimited && (hasCardSpinner || isTextQuerying);
        const { isDelivered, colD } = evaluateStatus(colC);

        if (colB || colC || isRateLimited) {
          results.push({
            trackingNumber,
            colB: isRateLimited ? '' : colB,
            colC: isRateLimited ? 'Not found' : colC,
            colD: isRateLimited ? '' : colD,
            isDelivered: isRateLimited ? false : isDelivered,
            isQuerying,
            isNotFound,
            isRateLimited,
          });
        }
      });

      if (hasDemoCard && results.length === 0 && codes && codes.length > 0) {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of buttons) {
          const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (/^track(\s*\(\d+\))?$/i.test(txt)) {
            btn.click();
            break;
          }
        }
      }

      let hasRateLimitMessage = results.some((r) => r.isRateLimited);
      if (!hasRateLimitMessage) {
        const pElements = Array.from(document.querySelectorAll('p, [role="alert"]'));
        for (const el of pElements) {
          if (isExactRateLimitText(el.textContent)) {
            hasRateLimitMessage = true;
            break;
          }
        }
      }

      return {
        items: results,
        totalCards: cards.length,
        pageSpinners,
        hasRateLimitMessage,
      };
    },
    { cardSel: CARD_SELECTOR, codes: expectedCodes, step: scrollStep }
  );
}

async function clickOrangeTrackOnPage(page) {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^track(\s*\(\d+\))?$/i.test(txt)) {
        btn.click();
        return true;
      }
    }
    return false;
  });
}

async function runFirstPass(browser, proxyConfig, batch) {
  const url = `https://t.17track.net/en#nums=${batch.join(',')}`;
  const page = await createConfiguredPage(browser, proxyConfig);
  let lastData = [];
  let lastHasRateLimit = false;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);

    const start = Date.now();
    let prevRealCount = -1;
    let stableTicks = 0;
    let scrollStep = 0;

    while (Date.now() - start < PER_ATTEMPT_TIMEOUT_MS) {
      const resp = await extractPageData(page, batch, scrollStep++);
      lastData = resp.items || [];
      lastHasRateLimit = Boolean(resp.hasRateLimitMessage || lastData.some((it) => it.isRateLimited));

      const realFound = lastData.filter(isRealTrackedItem);
      const querying = lastData.filter((it) => it.isQuerying);
      const elapsed = Date.now() - start;

      if (realFound.length > 0) {
        anchorGoodCode = realFound[0].trackingNumber;
      }

      if (realFound.length >= batch.length && querying.length === 0) {
        await sleep(300);
        const finalResp = await extractPageData(page, batch, scrollStep);
        return { data: finalResp.items || lastData, hasRateLimitMessage: false };
      }

      if (lastHasRateLimit && realFound.length === 0 && elapsed >= 4500) {
        return { data: lastData, hasRateLimitMessage: true };
      }

      if (lastData.length >= batch.length && querying.length === 0 && resp.pageSpinners === 0) {
        if (realFound.length > prevRealCount) {
          prevRealCount = realFound.length;
          stableTicks = 0;
        } else {
          stableTicks++;
        }
        if (elapsed >= 11000 && stableTicks >= 3) {
          return { data: lastData, hasRateLimitMessage: lastHasRateLimit };
        }
      } else {
        if (realFound.length > prevRealCount) prevRealCount = realFound.length;
        stableTicks = 0;
      }

      await sleep(1600);
    }

    return { data: lastData, hasRateLimitMessage: lastHasRateLimit };
  } finally {
    await page.close().catch(() => {});
  }
}

async function retryNotFoundWithAnchor(browser, proxyConfig, notFoundCodes) {
  const anchorKey = anchorGoodCode.trim().toUpperCase();
  const combinedCodes = [anchorGoodCode];
  for (const c of notFoundCodes) {
    if (c.trim().toUpperCase() !== anchorKey) combinedCodes.push(c);
  }

  const url = `https://t.17track.net/en#nums=${combinedCodes.join(',')}`;
  const page = await createConfiguredPage(browser, proxyConfig);
  let lastData = [];
  let lastHasRateLimit = false;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    const start = Date.now();
    let clickedSecondTry = false;
    let anchorLoadedTime = 0;
    let scrollStep = 0;

    while (Date.now() - start < 24000) {
      const resp = await extractPageData(page, combinedCodes, scrollStep++);
      lastData = resp.items || [];
      const querying = lastData.filter((it) => it.isQuerying);
      const hasRateLimit = Boolean(resp.hasRateLimitMessage || lastData.some((it) => it.isRateLimited));
      lastHasRateLimit = hasRateLimit;

      const anchorItem = lastData.find((it) => it.trackingNumber.trim().toUpperCase() === anchorKey);
      const targetReal = lastData.filter(
        (it) => it.trackingNumber.trim().toUpperCase() !== anchorKey && isRealTrackedItem(it)
      );
      const anchorOk = isRealTrackedItem(anchorItem);

      if (anchorOk && targetReal.length >= notFoundCodes.length && querying.length === 0) {
        return { anchorHasStatus: true, isRateLimited: false, items: lastData };
      }

      if (hasRateLimit && querying.length === 0 && !anchorOk) {
        return { anchorHasStatus: false, isRateLimited: true, items: lastData };
      }

      if (anchorOk && !hasRateLimit && querying.length === 0) {
        if (!anchorLoadedTime) anchorLoadedTime = Date.now();
        if (!clickedSecondTry && Date.now() - anchorLoadedTime >= 3000) {
          clickedSecondTry = true;
          await clickOrangeTrackOnPage(page);
          await sleep(5500);
          const finalResp = await extractPageData(page, combinedCodes, scrollStep);
          lastData = finalResp.items || lastData;
          const finalRateLimit = Boolean(
            finalResp.hasRateLimitMessage || lastData.some((it) => it.isRateLimited)
          );
          return {
            anchorHasStatus: !finalRateLimit,
            isRateLimited: finalRateLimit,
            items: lastData,
          };
        }
      }

      const elapsed = Date.now() - start;
      if (!clickedSecondTry && elapsed >= 10000 && !anchorOk && !hasRateLimit && querying.length === 0) {
        clickedSecondTry = true;
        await clickOrangeTrackOnPage(page);
        await sleep(6000);
      }

      await sleep(1500);
    }

    const finalAnchor = lastData.find((it) => it.trackingNumber.trim().toUpperCase() === anchorKey);
    const anyReal = lastData.some(isRealTrackedItem);
    return {
      anchorHasStatus: !lastHasRateLimit && (isRealTrackedItem(finalAnchor) || anyReal),
      isRateLimited: lastHasRateLimit,
      items: lastData,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function processBatch(browser, proxyConfig, batch, batchLabel) {
  const batchKeySet = new Set(batch.map((c) => c.trim().toUpperCase()));
  const dataMap = new Map();
  const verifiedKeys = new Set();

  for (const code of batch) {
    dataMap.set(code.trim().toUpperCase(), {
      trackingNumber: code,
      colB: '',
      colC: 'Not found',
      colD: '',
      isDelivered: false,
      isNotFound: true,
    });
  }

  const saveRecovered = (items) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it || !it.trackingNumber) continue;
      const k = it.trackingNumber.trim().toUpperCase();
      if (isRealTrackedItem(it)) anchorGoodCode = it.trackingNumber;
      if (!batchKeySet.has(k)) continue;
      if (isRealTrackedItem(it)) {
        dataMap.set(k, it);
        verifiedKeys.add(k);
      } else if (!isRealTrackedItem(dataMap.get(k))) {
        dataMap.set(k, it);
      }
    }
  };

  const buildRateLimitHalt = () => ({
    items: Array.from(dataMap.values()).filter((it) => verifiedKeys.has(it.trackingNumber.trim().toUpperCase())),
    haltedByRateLimit: true,
  });

  console.log(`🚀 Đang chạy ${batchLabel} (${batch.length} đơn)...`);
  const firstRes = await runFirstPass(browser, proxyConfig, batch);
  saveRecovered(firstRes.data);

  const missingCodes = batch.filter((c) => !isRealTrackedItem(dataMap.get(c.trim().toUpperCase())));
  if (missingCodes.length === 0) {
    return { items: Array.from(dataMap.values()), haltedByRateLimit: false };
  }

  if (firstRes.hasRateLimitMessage && firstRes.data.filter(isRealTrackedItem).length === 0) {
    return buildRateLimitHalt();
  }

  for (let i = 0; i < missingCodes.length; i += RETRY_CHUNK_SIZE) {
    const chunk = missingCodes.slice(i, i + RETRY_CHUNK_SIZE);
    console.log(
      `🔍 ${batchLabel}: Kiểm tra lại ${chunk.length} đơn Not found kèm đơn chuẩn (${anchorGoodCode})...`
    );
    const checkRes = await retryNotFoundWithAnchor(browser, proxyConfig, chunk);
    saveRecovered(checkRes.items);

    if (checkRes.isRateLimited && !checkRes.anchorHasStatus) {
      return buildRateLimitHalt();
    }

    if (checkRes.anchorHasStatus) {
      for (const c of chunk) verifiedKeys.add(c.trim().toUpperCase());
    }
  }

  return { items: Array.from(dataMap.values()), haltedByRateLimit: false };
}

async function main() {
  const runStartTime = Date.now();
  const allNums = await fetchAllTrackingNumbers();
  if (!allNums.length) {
    console.log('✅ Cột A không có mã vận đơn nào cần cập nhật.');
    saveState({ cursor: 0, totalOrders: 0, status: 'empty' });
    return;
  }

  const state = loadState();
  let cursor = state.cursor < allNums.length ? state.cursor : 0;
  let batchCounter = Math.floor(cursor / BATCH_SIZE);
  const totalBatches = Math.ceil(allNums.length / BATCH_SIZE);

  console.log(
    `📦 Tổng ${allNums.length} đơn (${totalBatches} lô) | Bắt đầu từ vị trí #${cursor} (Lô ${batchCounter + 1}/${totalBatches}) | Nghỉ ${Math.round(BATCH_INTERVAL_MS / 60000)} phút/lô.`
  );

  const proxyConfig = parseProxyConfig(PROXY_URL);
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
  ];
  if (proxyConfig && proxyConfig.server) {
    launchArgs.push(`--proxy-server=${proxyConfig.server}`);
    console.log(`🌐 Đang kết nối qua Proxy: ${proxyConfig.server}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: launchArgs,
  });

  try {
    while (cursor < allNums.length) {
      // Kiểm tra giới hạn an toàn 5 giờ của GitHub Actions trước khi chạy lô mới
      if (Date.now() - runStartTime >= MAX_RUN_MS) {
        console.log(
          `⏱️ Đã chạy gần chạm mốc tối đa ${Math.round(MAX_RUN_MS / 60000)} phút -> Lưu vị trí #${cursor}/${allNums.length} để phiên hẹn giờ tiếp theo chạy nối tiếp!`
        );
        saveState({ cursor, totalOrders: allNums.length, status: 'paused_time_limit' });
        return;
      }

      batchCounter++;
      const currentBatch = allNums.slice(cursor, cursor + BATCH_SIZE);
      const batchLabel = `Lô ${batchCounter}/${totalBatches}`;

      const result = await processBatch(browser, proxyConfig, currentBatch, batchLabel);

      if (result.items.length > 0) {
        const isFinal = !result.haltedByRateLimit && cursor + currentBatch.length >= allNums.length;
        const pushRes = await pushBatchToSheet(result.items, batchCounter, isFinal);
        console.log(
          `📤 Đã đẩy ${result.items.length} đơn của ${batchLabel} lên Sheet (updatedCount: ${pushRes.updatedCount ?? 'ok'}).`
        );
      }

      if (result.haltedByRateLimit) {
        console.log(
          `⛔ ${batchLabel}: 17track báo "Your tracking is too frequent, please try again later." -> Lưu mốc #${cursor}/${allNums.length} & DỪNG TOÀN BỘ để phiên sau chạy nối tiếp!`
        );
        saveState({ cursor, totalOrders: allNums.length, status: 'halted_rate_limit' });
        return;
      }

      cursor += currentBatch.length;
      saveState({ cursor, totalOrders: allNums.length, status: 'running' });
      console.log(`✅ Hoàn tất ${batchLabel} (${cursor}/${allNums.length} đơn).`);

      if (cursor < allNums.length && BATCH_INTERVAL_MS > 0) {
        // Nếu thời gian nghỉ vượt quá mốc an toàn 5 giờ -> dừng sớm và lưu cursor luôn
        if (Date.now() - runStartTime + BATCH_INTERVAL_MS >= MAX_RUN_MS) {
          console.log(
            `⏱️ Sắp chạm giới hạn thời gian phiên chạy -> Lưu mốc #${cursor}/${allNums.length} để phiên sau chạy nối tiếp!`
          );
          saveState({ cursor, totalOrders: allNums.length, status: 'paused_time_limit' });
          return;
        }
        console.log(`⏳ Đang nghỉ ${Math.round(BATCH_INTERVAL_MS / 60000)} phút trước khi chạy lô tiếp theo...`);
        await sleep(BATCH_INTERVAL_MS);
      }
    }

    console.log(`🎉 HOÀN TẤT TOÀN BỘ ${allNums.length} ĐƠN! Đặt lại cursor = 0 cho chu kỳ kế tiếp.`);
    saveState({ cursor: 0, totalOrders: allNums.length, status: 'completed' });
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('❌ Lỗi nghiêm trọng:', err);
  process.exit(1);
});
