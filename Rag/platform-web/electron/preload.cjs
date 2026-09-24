'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const config = ipcRenderer.sendSync('desktop:get-config')

contextBridge.exposeInMainWorld('desktopBridge', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  config: Object.freeze(config),
  setServerUrl: value => ipcRenderer.invoke('desktop:set-server-url', value),
  openExternal: value => ipcRenderer.invoke('desktop:open-external', value),
  onOpenSettings: callback => {
    const listener = () => callback()
    ipcRenderer.on('desktop:open-settings', listener)
    return () => ipcRenderer.removeListener('desktop:open-settings', listener)
  }
}))
