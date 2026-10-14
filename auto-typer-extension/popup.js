const $ = id => document.getElementById(id);
let activeTab;
let persistChain = Promise.resolve();
const busy = job => job && ['waiting', 'running'].includes(job.status);
const segments = value => Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value));
function message(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function saveDraft() {
  const draft = $('text').value;
  persistChain = persistChain.catch(() => {}).then(() => chrome.storage.session.set({ draft }));
  return persistChain;
}
function render(job) {
  $('start').disabled = busy(job) || !activeTab;
  $('stop').disabled = !busy(job);
  $('progress').max = job?.total || 1;
  $('progress').value = job?.done || 0;
  if (!job) return;
  const states = {
    waiting: `准备中：请返回目标网页并点击输入框（${job.delay} 秒）。`,
    running: `正在输入：${job.done} / ${job.total} 字`,
    complete: `输入完成：${job.done} / ${job.total} 字`,
    stopped: `已停止：${job.done} / ${job.total} 字。${job.reason || ''}`,
    error: job.reason || '输入失败，请重新选择网页输入框。'
  };
  message(states[job.status], job.status === 'error');
}
async function init() {
  const [tabs, settings, session] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get({ speed: 20, delay: 3 }),
    chrome.storage.session.get(['draft', 'job'])
  ]);
  activeTab = tabs[0];
  $('text').value = session.draft || '';
  $('speed').value = settings.speed;
  $('delay').value = settings.delay;
  $('length').textContent = `${segments($('text').value).length} 字`;
  render(session.job);
}
$('text').addEventListener('input', () => {
  $('length').textContent = `${segments($('text').value).length} 字`;
  saveDraft().catch(() => message('文字过长，无法保存到会话。', true));
});
$('clipboard').onclick = async () => {
  try {
    $('text').value = await navigator.clipboard.readText();
    $('text').dispatchEvent(new Event('input'));
    message('已读取剪贴板。点击开始后，返回网页选择输入框。');
  } catch {
    message('无法读取剪贴板，请在上方文本框按 Ctrl+V 粘贴。', true);
  }
};
$('start').onclick = async () => {
  if (!$('text').value) return message('请先粘贴要输入的文字。', true);
  const speed = Number($('speed').value), delay = Number($('delay').value);
  if (!Number.isFinite(speed) || speed < 1 || speed > 100 || !Number.isFinite(delay) || delay < 1 || delay > 30) {
    return message('速度需为 1–100 字/秒，准备时间需为 1–30 秒。', true);
  }
  $('start').disabled = true;
  try {
    await saveDraft();
    await chrome.storage.local.set({ speed, delay });
    const result = await chrome.runtime.sendMessage({ type: 'start', tabId: activeTab.id, text: $('text').value, speed, delay });
    if (!result?.ok) throw new Error(result?.error || '启动失败。');
    window.close();
  } catch (error) {
    $('start').disabled = false;
    message(error.message, true);
  }
};
$('stop').onclick = () => chrome.runtime.sendMessage({ type: 'stop' }).catch(error => message(error.message, true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.job) render(changes.job.newValue);
});
init().catch(error => message(error.message, true));
