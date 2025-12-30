const typeSelect = document.getElementById('exportType');
const startBtn = document.getElementById('startBtn');
const statusDiv = document.getElementById('status');
const warnDiv = document.getElementById('domainWarn');

async function checkDomainMatch() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return; // 避免未获取到tab报错
  
  const selected = typeSelect.value;
  const targetDomain = selected.startsWith('book') ? 'book.douban.com' : 'movie.douban.com';
  
  if (!tab.url || !tab.url.includes(targetDomain)) {
    warnDiv.style.display = 'block';
    warnDiv.textContent = `⚠️ 模式不匹配：当前选择需要 ${targetDomain}`;
    startBtn.disabled = true;
    startBtn.style.backgroundColor = '#ccc';
  } else {
    warnDiv.style.display = 'none';
    startBtn.disabled = false;
    startBtn.style.backgroundColor = '#37a000';
  }
}

typeSelect.addEventListener('change', checkDomainMatch);
checkDomainMatch();

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [category, state] = typeSelect.value.split('_'); 

  startBtn.disabled = true;
  startBtn.textContent = '抓取中...';
  statusDiv.textContent = '🚀 正在注入脚本...';

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  });

  chrome.tabs.sendMessage(tab.id, {
    action: "startScrape",
    config: { category, state }
  }).catch(err => {
    statusDiv.textContent = "❌ 注入失败，请刷新页面重试: " + err;
    startBtn.disabled = false;
    startBtn.textContent = '开始导出 CSV';
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "updateStatus") {
    statusDiv.innerText = request.message;
  }
  if (request.action === "finished") {
    statusDiv.innerText = "✅ 导出完成！文件已自动下载。";
    startBtn.disabled = false;
    startBtn.textContent = '开始导出 CSV';
  }
  if (request.action === "error") {
    statusDiv.innerText = "❌ 出错：" + request.message;
    startBtn.disabled = false;
    startBtn.textContent = '开始导出 CSV';
  }
});