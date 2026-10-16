const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freightApi', {
  getUsRates: () => ipcRenderer.invoke('get-us-rates'),
  getEuRates: () => ipcRenderer.invoke('get-eu-rates'),
  calculateUs: (data) => ipcRenderer.invoke('calculate-us', data),
  calculateEu: (data) => ipcRenderer.invoke('calculate-eu', data),
  updateUsRate: (data) => ipcRenderer.invoke('update-us-rate', data),
  updateEuRate: (data) => ipcRenderer.invoke('update-eu-rate', data),
  resetDatabase: () => ipcRenderer.invoke('reset-database')
});
