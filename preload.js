const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freightApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  calculate: data => ipcRenderer.invoke('calculate', data),
  saveGroup: data => ipcRenderer.invoke('save-group', data),
  addRateRow: data => ipcRenderer.invoke('add-rate-row', data),
  deleteRateRow: data => ipcRenderer.invoke('delete-rate-row', data),
  setVolDivisor: value => ipcRenderer.invoke('set-vol-divisor', value),
  resetDatabase: () => ipcRenderer.invoke('reset-database'),
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
});
