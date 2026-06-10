"use strict";

const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("katagoHuman", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  chooseKatago: () => ipcRenderer.invoke("app:choose-katago"),
  chooseHumanModel: () => ipcRenderer.invoke("app:choose-human-model"),
  chooseConfig: () => ipcRenderer.invoke("app:choose-config"),
  startEngine: () => ipcRenderer.invoke("app:start-engine"),
  stopEngine: () => ipcRenderer.invoke("app:stop-engine"),
  newGame: (opts) => ipcRenderer.invoke("app:new-game", opts),
  play: (point) => ipcRenderer.invoke("app:play", point),
  pass: () => ipcRenderer.invoke("app:pass"),
  undo: () => ipcRenderer.invoke("app:undo"),
  loadSgf: () => ipcRenderer.invoke("app:load-sgf"),
  saveSgf: () => ipcRenderer.invoke("app:save-sgf"),
  saveAsSgf: () => ipcRenderer.invoke("app:save-as-sgf"),
  copySgf: () => ipcRenderer.invoke("app:copy-sgf"),
  setOption: (key, value) => ipcRenderer.invoke("app:set-option", key, value),
  onState: (fn) => ipcRenderer.on("state", (_event, state) => fn(state)),
  onLog: (fn) => ipcRenderer.on("log", (_event, line) => fn(line))
});
