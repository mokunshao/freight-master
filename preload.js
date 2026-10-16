const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freightApi', {
  getUsRates: () => ipcRenderer.invoke('get-us-rates'),
  getEuRates: () => ipcRenderer.invoke('get-eu-rates'),
  calculateUs: data => ipcRenderer.invoke('calculate-us', data),
  calculateEu: data => ipcRenderer.invoke('calculate-eu', data),
  updateUsRate: data => ipcRenderer.invoke('update-us-rate', data),
  updateEuRate: data => ipcRenderer.invoke('update-eu-rate', data),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: data => ipcRenderer.invoke('update-settings', data),
  addEuRule: () => ipcRenderer.invoke('add-eu-rule'),
  updateEuRule: data => ipcRenderer.invoke('update-eu-rule', data),
  deleteEuRule: data => ipcRenderer.invoke('delete-eu-rule', data),
  resetDatabase: () => ipcRenderer.invoke('reset-database'),
});
