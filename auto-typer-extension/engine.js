(() => {
  if (globalThis.__cursorAutoTyper) return;
  let task = null;
  function activeElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }
  function editable(element) {
    if (!element || element.disabled || element.readOnly) return false;
    return element.tagName === 'TEXTAREA' ||
      (element.tagName === 'INPUT' && ['text', 'search', 'tel', 'url'].includes(element.type)) || element.isContentEditable;
  }
  function notify(status, reason = '') {
    if (!task) return Promise.resolve({ ok: false });
    return chrome.runtime.sendMessage({ type: 'engine-event', id: task.id, status, done: task.done, reason }).catch(() => ({ ok: false }));
  }
  function clear() {
    if (!task) return;
    clearTimeout(task.timer);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('blur', blur, true);
    task = null;
  }
  function finish(status, reason = '') {
    notify(status, reason);
    clear();
  }
  function escape(event) {
    if (event.key === 'Escape' && task) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish('stopped', '按 Esc 停止。');
    }
  }
  function blur() {
    if (task?.target) finish('stopped', '输入框失去了焦点。');
  }
  function insert(target, character) {
    // A real editing command runs in the target document; it generates input
    // events and preserves selection/undo in ordinary rich text editors.
    const singleLine = target.tagName === 'INPUT';
    const value = singleLine && character === '\n' ? ' ' : character;
    if (target.maxLength >= 0 && target.value !== undefined) {
      const selected = (target.selectionEnd || 0) - (target.selectionStart || 0);
      if (target.value.length - selected + value.length > target.maxLength) throw new Error('输入框已达到字数上限。');
    }
    const command = target.isContentEditable && value === '\n' ? 'insertLineBreak' : 'insertText';
    if (document.execCommand(command, false, command === 'insertLineBreak' ? null : value)) return;
    if (target.isContentEditable) throw new Error('此编辑器拒绝了输入命令，请尝试普通文本模式。');
    const before = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: value });
    if (!target.dispatchEvent(before)) throw new Error('网页阻止了自动输入。');
    const begin = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? begin;
    const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, target.value.slice(0, begin) + value + target.value.slice(end));
    target.setSelectionRange(begin + value.length, begin + value.length);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  }
  function tick() {
    if (!task) return;
    if (!document.hasFocus() || !task.target.isConnected || activeElement() !== task.target || !editable(task.target)) {
      return finish('stopped', '光标离开了目标输入框。');
    }
    if (task.done >= task.characters.length) return finish('complete');
    try { insert(task.target, task.characters[task.done]); }
    catch (error) { return finish('error', error.message); }
    // Input listeners on the page can synchronously remove/change the target.
    if (!task) return;
    task.done++;
    if (task.done >= task.characters.length) return finish('complete');
    if (performance.now() - task.lastUpdate > 250) {
      task.lastUpdate = performance.now();
      notify('running');
    }
    task.timer = setTimeout(tick, 1000 / task.speed);
  }
  globalThis.__cursorAutoTyper = {
    arm(payload) {
      clear();
      task = {
        ...payload, done: 0, target: null, lastUpdate: 0,
        characters: Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(payload.text.replace(/\r\n?/g, '\n')), part => part.segment)
      };
      document.addEventListener('keydown', escape, true);
      window.addEventListener('blur', blur, true);
      const id = task.id;
      task.timer = setTimeout(async () => {
        if (!task || task.id !== id) return;
        if (!document.hasFocus()) return clear();
        const target = activeElement();
        // The focused child frame handles the task, if accessible.
        if (target?.tagName === 'IFRAME' || target?.tagName === 'FRAME') return clear();
        if (!editable(target)) return finish('error', '请在倒计时结束前点击文本框或可编辑区域。密码框和数字框不支持。');
        task.target = target;
        const result = await notify('running');
        if (!task || task.id !== id) return;
        if (!result?.ok) return clear();
        tick();
      }, payload.delay * 1000);
    }
  };
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'stop-engine' && task?.id === message.id) clear();
  });
})();
