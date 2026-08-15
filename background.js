// background.js

let activeTabs = new Set();
let watchdogTimers = new Map();
let tabGroupId = null;

const WATCHDOG_TIMEOUT = 120000; // 120 秒超時
const MAX_CONCURRENCY = 10;     // 一次最多開 10 個分頁

// 啟動平行複製處理
async function spawnWorkers() {
  const data = await chrome.storage.local.get(['cloningState', 'places', 'currentIndex', 'targetListName']);

  if (data.cloningState !== 'saving') {
    return; // 非儲存中狀態就退出
  }

  const places = data.places || [];
  let index = data.currentIndex || 0;

  // 當目前執行的分頁數少於最大併發數，且還有地點未處理時，繼續開新分頁
  while (activeTabs.size < MAX_CONCURRENCY && index < places.length) {
    const currentPlace = places[index];
    index++;

    // 立即更新 currentIndex，避免其他平行程序拿到重複的索引
    await chrome.storage.local.set({ currentIndex: index });

    console.log(`[Cloner] 啟動平行複製 (${index}/${places.length}): ${currentPlace.name}`);

    // 建立後台分頁 (active: false)
    const tab = await chrome.tabs.create({ url: currentPlace.url, active: false });
    if (chrome.runtime.lastError || !tab) {
      console.error('[Cloner] 無法建立分頁，嘗試下一個', chrome.runtime.lastError);
      handleTabFinished(null); // 回報完成以推進佇列
      return;
    }

    const tabId = tab.id;
    activeTabs.add(tabId);

    // 加入專屬的分頁群組
    try {
      if (tabGroupId === null) {
        // 如果群組還不存在，將此分頁打包建立新群組
        tabGroupId = await chrome.tabs.group({ tabIds: [tabId] });
        await chrome.tabGroups.update(tabGroupId, {
          title: 'GMap Cloner (複製中)',
          color: 'purple'
        });
      } else {
        // 加入現有的群組
        await chrome.tabs.group({ groupId: tabGroupId, tabIds: [tabId] });
      }
    } catch (err) {
      console.warn('[Cloner] 分頁分組失敗 (可能瀏覽器不支援群組功能):', err);
    }

    // 啟動該分頁的看門狗超時器
    startWatchdogForTab(tabId, currentPlace.name);
  }

  // 檢查是否全部完成 (當沒有任何活動分頁，且索引也到底時)
  if (activeTabs.size === 0 && index >= places.length) {
    console.log('[Cloner] 所有景點複製完成！');
    await chrome.storage.local.set({ cloningState: 'done' });
    tabGroupId = null; // 重設群組 ID
  }
}

// 處理分頁完成（成功或失敗/超時）
async function handleTabFinished(tabId) {
  if (tabId) {
    clearWatchdogForTab(tabId);
    activeTabs.delete(tabId);

    // 關閉分頁
    chrome.tabs.remove(tabId, () => {
      if (chrome.runtime.lastError) {
        // 忽略已關閉分頁的錯誤
      }
    });
  }

  // 更新完成計數
  const storageData = await chrome.storage.local.get(['completedCount']);
  const completed = (storageData.completedCount || 0) + 1;
  await chrome.storage.local.set({ completedCount: completed });

  // 推進下一波分頁
  spawnWorkers();
}

// 看門狗：單一分頁超時處理
function startWatchdogForTab(tabId, placeName) {
  clearWatchdogForTab(tabId);
  const timer = setTimeout(() => {
    console.warn(`[Cloner] 分頁 ${tabId} (${placeName}) 處理超時，自動跳過`);
    handleTabFinished(tabId);
  }, WATCHDOG_TIMEOUT);
  watchdogTimers.set(tabId, timer);
}

function clearWatchdogForTab(tabId) {
  if (watchdogTimers.has(tabId)) {
    clearTimeout(watchdogTimers.get(tabId));
    watchdogTimers.delete(tabId);
  }
}

function clearAllWatchdogs() {
  for (const timer of watchdogTimers.values()) {
    clearTimeout(timer);
  }
  watchdogTimers.clear();
}

function cancelCloning() {
  clearAllWatchdogs();
  chrome.storage.local.set({ cloningState: 'idle' });

  // 關閉所有複製中分頁
  if (activeTabs.size > 0) {
    chrome.tabs.remove(Array.from(activeTabs), () => {
      if (chrome.runtime.lastError) {
        // 忽略錯誤
      }
    });
    activeTabs.clear();
  }
  tabGroupId = null;
}

// 監聽各組件訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startCloning') {
    clearAllWatchdogs();
    activeTabs.clear();
    tabGroupId = null;

    chrome.storage.local.set({
      cloningState: 'saving',
      places: message.places,
      currentIndex: 0,
      completedCount: 0,
      targetListName: message.targetListName,
      currentPlaceName: '正在啟動併發處理...'
    }).then(() => {
      spawnWorkers();
    });
    sendResponse({ success: true });
  }

  else if (message.action === 'cancelCloning') {
    cancelCloning();
    sendResponse({ success: true });
  }

  else if (message.action === 'checkIfCloningTab') {
    chrome.storage.local.get(['cloningState', 'targetListName', 'completedCount', 'places']).then((data) => {
      const isCloning = data.cloningState === 'saving' && sender.tab && activeTabs.has(sender.tab.id);
      sendResponse({
        isCloningTab: isCloning,
        targetListName: data.targetListName,
        index: data.completedCount || 0,
        total: data.places ? data.places.length : 0
      });
    });
    return true; // 異步回應
  }

  else if (message.action === 'placeSaved') {
    if (!message.success) {
      console.warn('[Cloner] 儲存失敗：', message.error);
      cancelCloning();
      chrome.runtime.sendMessage({ action: 'cloneError', error: message.error });
      return;
    }

    if (sender.tab && activeTabs.has(sender.tab.id)) {
      // 成功儲存後，延遲 300ms 關閉，給予 Google Maps 背景寫入資料庫時間
      setTimeout(() => {
        handleTabFinished(sender.tab.id);
      }, 300);
    }
    sendResponse({ success: true });
  }
});
