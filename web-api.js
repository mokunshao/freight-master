// 浏览器（局域网 server 模式）下的 API 实现：用 fetch 顶替 Electron 的 IPC
// Electron 里 preload.js 已经挂好了 window.freightApi，这里直接跳过，两边共用同一份 renderer.js
(function () {
  if (window.freightApi) return;

  async function call(name, payload) {
    const res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload === undefined ? {} : payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  function downloadJson(payload) {
    const fileName = `freight-master-config-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return fileName;
  }

  // 浏览器里没有原生保存对话框，改用「选择文件」读 JSON 后上传
  function pickJsonFile() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, text: String(reader.result) });
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  window.freightApi = {
    getConfig: () => call('getConfig'),
    calculate: data => call('calculate', data),
    saveGroup: data => call('saveGroup', data),
    addRateRow: data => call('addRateRow', data),
    deleteRateRow: data => call('deleteRateRow', data),
    setVolDivisor: value => call('setVolDivisor', { value }),
    resetDatabase: () => call('resetDatabase'),
    exportConfig: async () => {
      const payload = await call('exportConfig');
      return { ok: true, filePath: downloadJson(payload) };
    },
    importConfig: async () => {
      const picked = await pickJsonFile();
      if (!picked) return { ok: false, canceled: true };
      let payload;
      try {
        payload = JSON.parse(picked.text);
      } catch (err) {
        throw new Error('不是有效的 JSON 文件');
      }
      const res = await call('importConfig', payload);
      return { ok: true, filePath: picked.name, config: res.config };
    },
  };
})();
