// background.js

let currentTabId = null;
let watchdogTimer = null;
const WATCHDOG_TIMEOUT = 25000; // 25 秒超時，給予足夠的載入與操作時間

// 開始處理下一個地點
async function processNextPlace() {
  clearWatchdog();

  const data = await chrome.storage.local.get(['cloningState', 'places', 'currentIndex', 'targetListName']);
  
  if (data.cloningState !== 'saving') {
    return; // 已被取消或處於其他狀態
  }

  const places = data.places || [];
  const index = data.currentIndex || 0;

  if (index >= places.length) {
    // 所有地點皆已複製完成
    await chrome.storage.local.set({ cloningState: 'done' });
    currentTabId = null;
    return;
  }

  const currentPlace = places[index];
  
  // 更新當前儲存的地點名稱與索引
  await chrome.storage.local.set({
    currentPlaceName: currentPlace.name,
    currentIndex: index
  });

  console.log(`[Cloner] 正在複製 (${index + 1}/${places.length}): ${currentPlace.name}`);

  // 建立後台分頁 (active: false 代表不搶焦點)
  chrome.tabs.create({ url: currentPlace.url, active: false }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.error('[Cloner] 無法建立分頁，跳至下一個', chrome.runtime.lastError);
      skipToNext();
      return;
    }
    
    currentTabId = tab.id;
    
    // 設定看門狗定時器，避免分頁卡死或載入失敗
    startWatchdog(tab.id);
  });
}

// 跳過當前並處理下一個（用於錯誤或超時）
async function skipToNext() {
  const data = await chrome.storage.local.get(['currentIndex']);
  const nextIndex = (data.currentIndex || 0) + 1;
  await chrome.storage.local.set({ currentIndex: nextIndex });
  processNextPlace();
}

// 看門狗：超時自動關閉分頁並處理下一個
function startWatchdog(tabId) {
  clearWatchdog();
  watchdogTimer = setTimeout(async () => {
    console.warn(`[Cloner] 分頁 ${tabId} 處理超時，自動跳過`);
    try {
      // 檢查分頁是否還在，在的話就關閉
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          chrome.tabs.remove(tabId);
        }
      });
    } catch (e) {
      console.error(e);
    }
    skipToNext();
  }, WATCHDOG_TIMEOUT);
}

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

// 監聽來自 Popup 或 Content Script 的訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startCloning') {
    // 初始化複製狀態
    chrome.storage.local.set({
      cloningState: 'saving',
      places: message.places,
      currentIndex: 0,
      targetListName: message.targetListName,
      currentPlaceName: message.places[0]?.name || ''
    }).then(() => {
      processNextPlace();
    });
    sendResponse({ success: true });
  } 
  
  else if (message.action === 'cancelCloning') {
    clearWatchdog();
    chrome.storage.local.set({ cloningState: 'idle' });
    if (currentTabId) {
      chrome.tabs.remove(currentTabId, () => {
        if (chrome.runtime.lastError) {
          // 忽略已關閉分頁的錯誤
        }
      });
      currentTabId = null;
    }
    sendResponse({ success: true });
  } 
  
  else if (message.action === 'checkIfCloningTab') {
    // 檢查這個載入的 content.js 是否為我們用來複製的後台分頁
    chrome.storage.local.get(['cloningState', 'targetListName', 'currentIndex', 'places']).then((data) => {
      const isCloning = data.cloningState === 'saving' && sender.tab && sender.tab.id === currentTabId;
      sendResponse({
        isCloningTab: isCloning,
        targetListName: data.targetListName,
        index: data.currentIndex,
        total: data.places ? data.places.length : 0
      });
    });
    return true; // 非同步回應
  } 
  
  else if (message.action === 'placeSaved') {
    if (sender.tab && sender.tab.id === currentTabId) {
      clearWatchdog();
      
      // 關閉完成儲存的分頁
      chrome.tabs.remove(sender.tab.id, () => {
        if (chrome.runtime.lastError) {
          // 忽略錯誤
        }
      });
      currentTabId = null;

      // 索引遞增並處理下一個
      chrome.storage.local.get(['currentIndex']).then((data) => {
        const nextIndex = (data.currentIndex || 0) + 1;
        chrome.storage.local.set({ currentIndex: nextIndex }).then(() => {
          // 延遲一點點時間再處理下一個，模擬人為操作也給 Google Maps 一點反應時間
          setTimeout(processNextPlace, 1000);
        });
      });
    }
    sendResponse({ success: true });
  }
});
