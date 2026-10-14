// Serializing state changes keeps stop/completion/progress messages in order.
let queue = Promise.resolve();
function serial(fn) {
  const task = queue.then(fn, fn);
  queue = task.catch(() => {});
  return task;
}
const busy = job => job && ['waiting', 'running'].includes(job.status);
async function write(job) {
  await chrome.storage.session.set({ job });
  await chrome.action.setBadgeText({ text: busy(job) ? (job.status === 'waiting' ? '…' : 'ON') : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#275ad8' });
}
async function stop(reason = '手动停止。') {
  const { job } = await chrome.storage.session.get('job');
  if (!busy(job)) return;
  await write({ ...job, status: 'stopped', reason });
  await chrome.tabs.sendMessage(job.tabId, { type: 'stop-engine', id: job.id }).catch(() => {});
}
async function start(data) {
  if (typeof data.text !== 'string' || !data.text.length || data.text.length > 100000) {
    throw new Error('请输入 1–100000 个字符。');
  }
  if (!Number.isFinite(data.speed) || data.speed < 1 || data.speed > 100 || !Number.isFinite(data.delay) || data.delay < 1 || data.delay > 30) {
    throw new Error('速度或准备时间超出范围。');
  }
  const tab = await chrome.tabs.get(data.tabId);
  if (!/^(https?|file):\/\//.test(tab.url || '')) {
    throw new Error('请在普通网站中使用；浏览器设置页、新标签页和扩展商店不支持输入。');
  }
  await stop('已开始新的输入任务。');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['engine.js'] });
  } catch {
    throw new Error('无法访问此网页，请刷新网页后重试。浏览器内置页面和扩展商店不支持。');
  }
  const job = {
    id: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, status: 'waiting',
    done: 0, total: Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(data.text.replace(/\r\n?/g, '\n'))).length,
    delay: data.delay
  };
  await write(job);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: payload => globalThis.__cursorAutoTyper.arm(payload),
      args: [{ id: job.id, text: data.text, speed: data.speed, delay: data.delay }]
    });
  } catch {
    await write({ ...job, status: 'error', reason: '网页已刷新或关闭，请重新启动。' });
    throw new Error('网页已刷新或关闭，请重新启动。');
  }
  // Only a focused editable frame claims the task. If none does, report it.
  setTimeout(() => serial(async () => {
    const { job: current } = await chrome.storage.session.get('job');
    if (current?.id === job.id && current.status === 'waiting') {
      await write({ ...current, status: 'error', reason: '未找到获得焦点的输入框。请增加准备时间并点击可编辑区域；跨域内嵌编辑器可能需要在独立网页中打开。' });
      await chrome.tabs.sendMessage(job.tabId, { type: 'stop-engine', id: job.id }).catch(() => {});
    }
  }), data.delay * 1000 + 1500);
  return { ok: true };
}
chrome.runtime.onMessage.addListener((data, sender, reply) => {
  if (data.type === 'start' || data.type === 'stop') {
    if (sender.tab || sender.id !== chrome.runtime.id) return;
    serial(() => data.type === 'start' ? start(data) : stop().then(() => ({ ok: true })))
      .then(reply, error => reply({ ok: false, error: error.message }));
    return true;
  }
  if (data.type === 'engine-event') {
    serial(async () => {
      const { job } = await chrome.storage.session.get('job');
      if (!busy(job) || job.id !== data.id || sender.tab?.id !== job.tabId) return { ok: false };
      if (job.frameId !== undefined && job.frameId !== sender.frameId) return { ok: false };
      const next = { ...job, frameId: sender.frameId, status: data.status, done: data.done ?? job.done, reason: data.reason || '' };
      await write(next);
      return { ok: true };
    }).then(reply, () => reply({ ok: false }));
    return true;
  }
});
chrome.commands.onCommand.addListener(command => {
  if (command === 'stop-typing') serial(() => stop());
});
chrome.tabs.onActivated.addListener(info => serial(async () => {
  const { job } = await chrome.storage.session.get('job');
  if (busy(job) && info.tabId !== job.tabId) await stop('切换了标签页。');
}));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') serial(async () => {
    const { job } = await chrome.storage.session.get('job');
    if (busy(job) && job.tabId === tabId) await stop('目标网页正在跳转或刷新。');
  });
});
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const { job } = await chrome.storage.session.get('job');
  if (busy(job) && job.tabId === tabId) await stop('目标标签页已关闭。');
}));
