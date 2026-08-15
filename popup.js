document.addEventListener('DOMContentLoaded', async () => {
  // UI 元素
  const stateStart = document.getElementById('state-start');
  const stateLoading = document.getElementById('state-loading');
  const stateError = document.getElementById('state-error');
  const stateReady = document.getElementById('state-ready');
  const stateProgress = document.getElementById('state-progress');
  const stateDone = document.getElementById('state-done');

  const sourceListName = document.getElementById('source-list-name');
  const sourcePlaceCount = document.getElementById('source-place-count');
  const targetListNameInput = document.getElementById('target-list-name');

  const btnFetchList = document.getElementById('btn-fetch-list');
  const btnCancelScrape = document.getElementById('btn-cancel-scrape');
  const btnErrorBack = document.getElementById('btn-error-back');
  const btnCancelReady = document.getElementById('btn-cancel-ready');
  const btnStartClone = document.getElementById('btn-start-clone');
  const btnCancelClone = document.getElementById('btn-cancel-clone');

  const errorMessageText = document.getElementById('error-message-text');
  const errorTitle = document.getElementById('error-title');

  const progressStatusText = document.getElementById('progress-status-text');
  const progressPercentage = document.getElementById('progress-percentage');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressFraction = document.getElementById('progress-fraction');
  const progressCurrentItem = document.getElementById('progress-current-item');

  // 切換視圖
  function showState(state) {
    stateStart.classList.add('hidden');
    stateLoading.classList.add('hidden');
    stateError.classList.add('hidden');
    stateReady.classList.add('hidden');
    stateProgress.classList.add('hidden');
    stateDone.classList.add('hidden');

    if (state === 'start') stateStart.classList.remove('hidden');
    else if (state === 'loading') stateLoading.classList.remove('hidden');
    else if (state === 'error') stateError.classList.remove('hidden');
    else if (state === 'ready') stateReady.classList.remove('hidden');
    else if (state === 'progress') stateProgress.classList.remove('hidden');
    else if (state === 'done') stateDone.classList.remove('hidden');
  }

  // 從 storage 更新 UI 狀態
  async function updateUIFromStorage() {
    const data = await chrome.storage.local.get([
      'cloningState',
      'places',
      'completedCount',
      'targetListName',
      'currentPlaceName',
      'errorMessage',
      'scrapedPlaces',
      'scrapedListName'
    ]);

    if (data.cloningState === 'saving') {
      showState('progress');
      const total = data.places ? data.places.length : 0;
      const completed = data.completedCount || 0;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      progressPercentage.textContent = `${pct}%`;
      progressBarFill.style.width = `${pct}%`;
      progressFraction.textContent = `${completed} / ${total} 已儲存`;
      progressCurrentItem.textContent = data.currentPlaceName || '正在準備中...';
      progressStatusText.textContent = `正在複製地點 (${Math.min(completed + 1, total)}/${total})...`;
    } else if (data.cloningState === 'scraping') {
      showState('loading');
    } else if (data.cloningState === 'scraped') {
      if (data.scrapedPlaces && data.scrapedPlaces.length > 0) {
        sourceListName.textContent = data.scrapedListName || '未命名清單';
        sourcePlaceCount.textContent = `${data.scrapedPlaces.length} 個地點`;
        // 清空匯入清單名稱，讓使用者自己輸入
        targetListNameInput.value = '';

        showState('ready');
      } else {
        showState('error');
        if (errorTitle) errorTitle.textContent = '未偵測到清單地點';
        if (errorMessageText) errorMessageText.textContent = '此頁面未偵測到任何地點，請確定清單中已有景點並已完全載入。';
        await chrome.storage.local.set({ cloningState: 'idle' });
      }
    } else if (data.cloningState === 'done') {
      showState('done');
      // 清除狀態以防下次重複顯示
      await chrome.storage.local.set({ cloningState: 'idle' });
    } else if (data.cloningState === 'error') {
      showState('error');
      if (errorTitle) errorTitle.textContent = '發生錯誤';
      if (errorMessageText) errorMessageText.innerHTML = data.errorMessage || '擷取清單時發生未知錯誤，請重試。';
      console.error(data.errorMessage);
      await chrome.storage.local.set({ cloningState: 'idle' });
    }
  }

  // 初始化：檢查當前分頁與狀態
  async function initialize() {
    // 檢查 background/content 是否正在執行複製或擷取
    const data = await chrome.storage.local.get(['cloningState']);
    if (data.cloningState === 'saving' || data.cloningState === 'scraping' || data.cloningState === 'scraped') {
      updateUIFromStorage();
      return;
    }

    showState('start');
  }

  // 開始擷取清單按鈕事件
  btnFetchList.addEventListener('click', async () => {
    // 獲取當前分頁
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      showState('error');
      if (errorTitle) errorTitle.textContent = '無法獲取分頁資訊';
      if (errorMessageText) errorMessageText.textContent = '請確定您已開啟瀏覽器分頁。';
      return;
    }

    // 檢查是否為 Google Maps 清單網址
    const isGMap = tab.url.includes('/maps/') && tab.url.includes('google.');
    if (!isGMap) {
      showState('error');
      if (errorTitle) errorTitle.textContent = '未偵測到清單頁面';
      if (errorMessageText) errorMessageText.innerHTML = '請在瀏覽器中切換至 Google Maps 的共享清單頁面。';
      return;
    }

    // 設定狀態為 scraping 並記錄 tab.id
    await chrome.storage.local.set({
      cloningState: 'scraping',
      scrapeTabId: tab.id
    });

    // 向 content.js 發送抓取清單指令
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'scrapeList' }, async (response) => {
        // 如果連不上 content.js，表示可能需要重新整理
        if (chrome.runtime.lastError || !response) {
          // 只有在當前狀態依然是 scraping 時才更新為錯誤，避免 content.js 已非同步更新儲存區的情況
          const stateData = await chrome.storage.local.get(['cloningState']);
          if (stateData.cloningState === 'scraping') {
            await chrome.storage.local.set({
              cloningState: 'error',
              errorMessage: '無法連線至頁面，請<strong>重新整理該 Google Maps 頁面</strong>後再試一次。',
              scrapeTabId: null
            });
          }
        }
      });
    } catch (e) {
      await chrome.storage.local.set({
        cloningState: 'error',
        errorMessage: '擷取指令傳送失敗，請重新整理該頁面後再試一次。',
        scrapeTabId: null
      });
    }
  });

  // 取消擷取按鈕事件
  btnCancelScrape.addEventListener('click', async () => {
    // 發送取消指令給儲存的分頁
    const data = await chrome.storage.local.get(['scrapeTabId']);
    if (data.scrapeTabId) {
      chrome.tabs.sendMessage(data.scrapeTabId, { action: 'cancelScrape' }, () => {
        // 忽略錯誤，以防 content.js 未載入
        if (chrome.runtime.lastError) { }
      });
    }
    await chrome.storage.local.set({ cloningState: 'idle', scrapeTabId: null });
    showState('start');
  });

  // 錯誤返回按鈕事件
  btnErrorBack.addEventListener('click', async () => {
    await chrome.storage.local.set({ cloningState: 'idle' });
    showState('start');
  });

  // 開始複製按鈕事件
  btnStartClone.addEventListener('click', async () => {
    const targetName = targetListNameInput.value.trim();
    if (!targetName) {
      alert('請輸入匯入清單名稱！');
      return;
    }

    const data = await chrome.storage.local.get(['scrapedPlaces']);
    if (!data.scrapedPlaces || data.scrapedPlaces.length === 0) {
      alert('未找到可複製的地點，請重試！');
      return;
    }

    showState('progress');
    progressPercentage.textContent = '0%';
    progressBarFill.style.width = '0%';
    progressFraction.textContent = `0 / ${data.scrapedPlaces.length} 已儲存`;
    progressCurrentItem.textContent = '正在啟動複製程序...';

    // 傳送指令給 background.js 開始進行佇列處理
    chrome.runtime.sendMessage({
      action: 'startCloning',
      targetListName: targetName,
      places: data.scrapedPlaces
    });
  });

  // 取消複製按鈕事件
  btnCancelClone.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelCloning' });
    showState('ready');
  });

  // 取消準備複製狀態，返回主畫面
  btnCancelReady.addEventListener('click', async () => {
    await chrome.storage.local.set({
      cloningState: 'idle',
      scrapedPlaces: [],
      scrapedListName: ''
    });
    showState('start');
  });

  // 監聽來自 background 的 storage 變更
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      updateUIFromStorage();
    }
  });

  // 監聽來自 background 的訊息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'cloneError') {
      showState('error');
      if (errorTitle) errorTitle.textContent = message.error;
      if (errorMessageText) errorMessageText.innerHTML = '複製過程中發生錯誤，已停止複製程序。';
    }
  });

  // 執行初始化
  initialize();
});
