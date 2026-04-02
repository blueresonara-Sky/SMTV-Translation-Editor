const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("subtitleApp", {
  checkForAppUpdate: () => ipcRenderer.invoke("check-for-app-update"),
  getAppMeta: () => ipcRenderer.invoke("get-app-meta"),
  getAppSettings: () => ipcRenderer.invoke("get-app-settings"),
  getPathForDroppedFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_error) {
      return "";
    }
  },
  pickInputFile: () => ipcRenderer.invoke("pick-input-file"),
  runRearrangement: (inputPath, options) =>
    ipcRenderer.invoke("run-rearrangement", { inputPath, options }),
  saveAppSettings: (settings) => ipcRenderer.invoke("save-app-settings", settings)
});
