// content.js

const delay = ms => new Promise(res => setTimeout(res, ms));

let isScrapeCancelled = false;

// ==========================================
// 作用 A：抓取清單頁面的地點
// ==========================================

// 尋找可滾動的側邊欄容器
function findScrollContainer() {
  return document.querySelector('.ussYcc');
}

// 滾動到最底部以載入所有懶加載的地點
async function scrollToBottom(container) {
  return new Promise((resolve) => {
    let lastHeight = container.scrollHeight;
    let attempts = 0;

    const interval = setInterval(() => {
      if (isScrapeCancelled) {
        clearInterval(interval);
        resolve();
        return;
      }
      container.scrollTop = container.scrollHeight;

      const newHeight = container.scrollHeight;
      if (newHeight === lastHeight) {
        attempts++;
        if (attempts > 20) { // 連續 20 次高度沒有變化，視為已到底部
          clearInterval(interval);
          resolve();
        }
      } else {
        lastHeight = newHeight;
        attempts = 0;
      }
    }, 50);
  });
}

// ==========================================
// 作用 B：自動化儲存地點
// ==========================================

// 尋找儲存按鈕
function findSaveButton() {
  const buttons = Array.from(document.querySelectorAll('button[jslog]'));
  return buttons.find(btn => {
    const jslog = btn.getAttribute('jslog');
    // 觀察結果，未來 google 可能會改，失效再去看 html 結構有沒有什麼特徵
    return jslog.includes('13535');
  });
}

// 取儲存視窗元件
function getSaveDialogContainer() {
  const dialogTitle = document.querySelector('div[aria-label="儲存至清單中"]');
  return dialogTitle;
}

// 尋找清單彈窗中的特定清單列
function findListRow(dialog, targetName) {
  const divs = Array.from(dialog.querySelectorAll('div'));
  const textElements = divs.filter(el => el.textContent.trim() === targetName);

  for (const el of textElements) {
    const container = el.closest('div[jsaction]');
    if (container) return container;
  }
  return null;
}

// 執行儲存自動化流程
async function runSaveFlow(targetListName) {
  console.log('[Cloner] 啟動自動儲存流程，目標清單：', targetListName);

  // 1. 等待儲存按鈕出現 (有可能遇到機器人驗證，要手動處理，所以不設上限時間)
  let saveBtn = null;
  while (true) {
    saveBtn = findSaveButton();
    if (saveBtn) break;
    await delay(500);
  }
  const currentSaveLabel = saveBtn.getAttribute('aria-label');

  // 2. 點擊儲存按鈕
  console.log('[Cloner] 點擊儲存按鈕');
  saveBtn.click();

  // 3. 等待儲存彈窗出現
  let dialog = null;
  while (!dialog) {
    for (let i = 0; i < 10; i++) {
      dialog = getSaveDialogContainer();
      if (dialog) break;
      await delay(300);
    }
    console.log('[Cloner] 儲存清單未出現，再次點擊儲存按鈕');
    saveBtn.click();
  }

  // 4. 尋找目標清單
  let listRow = findListRow(dialog, targetListName);
  if (listRow) {
    console.log('[Cloner] 找到目標清單，檢查是否已勾選');
    // 檢查是否已勾選 (透過 accessibility 屬性或是 checkbox)
    const isChecked = listRow.getAttribute('aria-checked') === 'true';

    if (!isChecked) {
      console.log('[Cloner] 點擊勾選清單');
      listRow.click();
      // 等待儲存完成（按鈕文字改變）
      while (true) {
        if (saveBtn.getAttribute('aria-label') !== currentSaveLabel) {
          break;
        }
        await delay(300);
      }
    } else {
      console.log('[Cloner] 已在清單中，跳過點擊');
    }
  } else {
    // 5. 找不到清單，終止流程
    console.log('[Cloner] 未找到目標清單');
    chrome.runtime.sendMessage({ action: 'placeSaved', success: false, error: '找不到目標清單' });
    return;
  }

  // 6. 等待儲存完成，通知 background.js 處理下一個
  console.log('[Cloner] 儲存完畢，回報成功');
  chrome.runtime.sendMessage({ action: 'placeSaved', success: true });
}

// ==========================================
// 訊息監聽與啟動入口
// ==========================================

// 監聽 Popup 的抓取請求與取消請求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scrapeList') {
    scrapeAndScroll(sendResponse);
    return true; // 表示非同步回應
  } else if (message.action === 'cancelScrape') {
    isScrapeCancelled = true;
    sendResponse({ success: true });
  }
});

// 當頁面載入時，主動向 background.js 詢問是否需要自動化儲存
chrome.runtime.sendMessage({ action: 'checkIfCloningTab' }, (response) => {
  if (response && response.isCloningTab) {
    runSaveFlow(response.targetListName);
  }
});

// 輔助功能：返回原先清單頁面
async function restoreOriginalState(originalUrl) {
  for (let i = 0; i < 25; i++) {
    if (window.location.href.includes('/place/')) {
      window.history.back();
      await delay(250);
    } else {
      break;
    }
  }
  if (window.location.href !== originalUrl) {
    window.history.replaceState(null, '', originalUrl);
  }
}

async function scrapeAndScroll(sendResponse) {
  console.log('[Cloner] 開始滾動並抓取清單中...');
  isScrapeCancelled = false; // 重設取消狀態
  // 寫入 scraping 狀態以供 popup 讀取（即使 popup 關閉重開）
  await chrome.storage.local.set({ cloningState: 'scraping' });

  const scrollContainer = findScrollContainer();
  if (scrollContainer) {
    await scrollToBottom(scrollContainer);
  } else {
    console.warn('[Cloner] 未找到明顯滾動容器，將直接讀取畫面上現有地點');
  }

  if (isScrapeCancelled) {
    console.log('[Cloner] 擷取已被取消，終止程序');
    await chrome.storage.local.set({ cloningState: 'idle' });
    sendResponse({ success: false, error: '擷取已被取消' });
    return;
  }

  const places = [];
  const placesMap = new Map();

  // 1. 觀察到列表項目有 SMP2wb 這個獨特 class 類別
  const buttons = Array.from(document.querySelectorAll('button.SMP2wb'));

  // 獲取清單標題
  const listName = document.title.replace(' - Google Maps', '').replace(' - Google 地圖', '').trim();

  if (buttons.length > 0) {
    console.log(`[Cloner] 偵測到有 ${buttons.length} 個景點按鈕 (SMP2wb)，啟動模擬點擊獲取 URL 流程...`);
    const originalListUrl = window.location.href;

    let lastUrl = originalListUrl;
    for (let i = 0; i < buttons.length; i++) {
      if (isScrapeCancelled) {
        break;
      }
      const btn = buttons[i];
      let name = btn.getAttribute('aria-label') || btn.textContent || '';
      name = name.trim();
      let cleanName = name;
      if (name.includes('\n')) {
        cleanName = name.split('\n')[0].trim();
      }
      if (cleanName.includes('·')) {
        cleanName = cleanName.split('·')[0].trim();
      }

      // 點擊按鈕
      btn.click();
      let placeUrl = '';

      // 等待網址變更為包含 /place/
      for (let j = 0; j < 5; j++) {
        for (let k = 0; k < 10; k++) {
          if (isScrapeCancelled) break;
          await delay(100);
          if (window.location.href != lastUrl) {
            placeUrl = window.location.href;
            lastUrl = placeUrl;
            break;
          }
        }
        if (isScrapeCancelled) break;
        // 一段時間還沒變再點一次
        if (placeUrl) {
          break;
        }
        btn.click();
      }

      if (isScrapeCancelled) break;

      if (placeUrl) {
        if (!placesMap.has(placeUrl)) {
          placesMap.set(placeUrl, true);
          places.push({ name: cleanName, url: placeUrl });
          console.log(`[Cloner] 成功抓取 (${places.length}/${buttons.length}): ${cleanName}`);
        }
      } else {
        console.warn(`[Cloner] 按鈕點擊後超時未取得網址: ${cleanName}`);
      }
    }

    // 恢復到原始清單頁面
    console.log('[Cloner] 正在恢復原始清單頁面狀態...');
    await restoreOriginalState(originalListUrl);
  }

  if (isScrapeCancelled) {
    console.log('[Cloner] 擷取已被取消，終止程序');
    await chrome.storage.local.set({ cloningState: 'idle' });
    sendResponse({ success: false, error: '擷取已被取消' });
    return;
  }

  console.log(`[Cloner] 抓取完成，共 ${places.length} 個地點。清單標題：${listName}`);

  if (places.length > 0) {
    await chrome.storage.local.set({
      cloningState: 'scraped',
      scrapedPlaces: places,
      scrapedListName: listName || '未命名清單'
    });
  } else {
    await chrome.storage.local.set({
      cloningState: 'error',
      errorMessage: '此頁面未偵測到任何地點，請確定清單中已有景點並已完全載入。'
    });
  }

  sendResponse({
    success: places.length > 0,
    listName: listName || '未命名清單',
    places: places
  });
}
