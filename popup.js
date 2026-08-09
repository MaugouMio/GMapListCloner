document.addEventListener('DOMContentLoaded', async () => {
  // UI 元素
  const stateLoading = document.getElementById('state-loading');
  const stateError = document.getElementById('state-error');
  const stateReady = document.getElementById('state-ready');
  const stateProgress = document.getElementById('state-progress');
  const stateDone = document.getElementById('state-done');

  const sourceListName = document.getElementById('source-list-name');
  const sourcePlaceCount = document.getElementById('source-place-count');
  const targetListNameInput = document.getElementById('target-list-name');

  const btnStartClone = document.getElementById('btn-start-clone');
  const btnCancelClone = document.getElementById('btn-cancel-clone');

  const progressStatusText = document.getElementById('progress-status-text');
  const progressPercentage = document.getElementById('progress-percentage');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressFraction = document.getElementById('progress-fraction');
  const progressCurrentItem = document.getElementById('progress-current-item');

  // 切換視圖
  function showState(state) {
    stateLoading.classList.add('hidden');
    stateError.classList.add('hidden');
    stateReady.classList.add('hidden');
    stateProgress.classList.add('hidden');
    stateDone.classList.add('hidden');

    if (state === 'loading') stateLoading.classList.remove('hidden');
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
      'currentIndex',
      'targetListName',
      'currentPlaceName',
      'errorMessage'
    ]);

    if (data.cloningState === 'saving') {
      showState('progress');
      const total = data.places ? data.places.length : 0;
      const current = data.currentIndex || 0;
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;

      progressPercentage.textContent = `${pct}%`;
      progressBarFill.style.width = `${pct}%`;
      progressFraction.textContent = `${current} / ${total} 已儲存`;
      progressCurrentItem.textContent = data.currentPlaceName || '正在準備中...';
      progressStatusText.textContent = `正在複製地點 (${current + 1}/${total})...`;
    } else if (data.cloningState === 'done') {
      showState('done');
      // 清除狀態以防下次重複顯示
      await chrome.storage.local.set({ cloningState: 'idle' });
    } else if (data.cloningState === 'error') {
      showState('error');
      // 如果有具體錯誤訊息，可以印在 console 或 alert-text
      console.error(data.errorMessage);
      await chrome.storage.local.set({ cloningState: 'idle' });
    }
  }

  // 初始化：檢查當前分頁與狀態
  async function initialize() {
    // 先看 background 是否正在執行複製
    const data = await chrome.storage.local.get(['cloningState']);
    if (data.cloningState === 'saving') {
      updateUIFromStorage();
      return;
    }

    // 獲取當前分頁
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      showState('error');
      return;
    }

    // 檢查是否為 Google Maps 清單網址
    const isGMap = tab.url.includes('/maps/') && tab.url.includes('google.');
    if (!isGMap) {
      showState('error');
      return;
    }

    showState('loading');

    // 向 content.js 發送抓取清單指令
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'scrapeList' }, async (response) => {
        // 如果連不上 content.js
        if (chrome.runtime.lastError || !response) {
          showState('error');
          // 顯示需要重新整理的提示
          const errorP = stateError.querySelector('p');
          if (errorP) errorP.innerHTML = '無法連線至頁面，請<strong>重新整理該 Google Maps 頁面</strong>後再試一次。';
          return;
        }

        if (response.success && response.places && response.places.length > 0) {
          sourceListName.textContent = response.listName || '未命名清單';
          sourcePlaceCount.textContent = `${response.places.length} 個地點`;

          // 預設新清單名稱為：原清單名 - 副本
          const defaultName = (response.listName || '未命名清單') + ' - 副本';
          targetListNameInput.value = defaultName;

          // 存入臨時儲存區
          await chrome.storage.local.set({
            scrapedPlaces: response.places,
            scrapedListName: response.listName
          });

          showState('ready');
        } else {
          showState('error');
          const errorP = stateError.querySelector('p');
          if (errorP) errorP.textContent = '此頁面未偵測到任何地點，請確定清單中已有景點並已完全載入。';
        }
      });
    } catch (e) {
      showState('error');
    }
  }

  // 開始複製按鈕事件
  btnStartClone.addEventListener('click', async () => {
    const targetName = targetListNameInput.value.trim();
    if (!targetName) {
      alert('請輸入新清單名稱！');
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

  // 監聽來自 background 的 storage 變更
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      updateUIFromStorage();
    }
  });

  // 執行初始化
  initialize();
});
