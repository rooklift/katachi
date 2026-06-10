"use strict";

const {app, BrowserWindow, clipboard, dialog, ipcMain, Menu} = require("electron");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

global.alert = console.log;
global.config = {zobrist_checks: false};

const newNode = require("./modules/node");
const loadSgf = require("./modules/load_sgf");
const {tree_string} = require("./modules/save_sgf");

let win = null;
let root = null;
let currentNode = null;
let currentFile = "";
let dirty = false;
let querySeq = 1;
let pendingQuery = null;
let engineProcess = null;
let engineReady = false;
let engineStarting = false;
let stderrTail = [];

const state = {
  config: {
    katagoPath: "",
    humanModelPath: "",
    configPath: "",
    humanProfile: "rank_5k",
    humanColor: "b",
    topPolicy: false,
    boardSize: 19,
    komi: 7.5,
    rules: "Chinese",
    windowSize: {
      width: 1180,
      height: 820
    }
  },
  engine: {
    running: false,
    ready: false,
    starting: false
  },
  status: ""
};

function userDataFile(name) {
  return path.join(app.getPath("userData"), name);
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(userDataFile("config.json"), "utf8");
    Object.assign(state.config, JSON.parse(raw));
  } catch (_err) {
    // First run or unreadable config; defaults are enough.
  }
}

function saveConfig() {
  fs.mkdirSync(app.getPath("userData"), {recursive: true});
  fs.writeFileSync(userDataFile("config.json"), JSON.stringify(state.config, null, 2));
}

function windowDimension(value, fallback, min) {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(min, Math.round(n));
  return fallback;
}

function getSavedWindowSize() {
  const saved = state.config.windowSize || {};
  return {
    width: windowDimension(saved.width, 1180, 900),
    height: windowDimension(saved.height, 820, 640)
  };
}

function saveWindowSize() {
  if (!win || win.isDestroyed()) return;
  const bounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds();
  state.config.windowSize = {
    width: windowDimension(bounds.width, 1180, 900),
    height: windowDimension(bounds.height, 820, 640)
  };
  saveConfig();
}

function createWindow() {
  const savedSize = getSavedWindowSize();
  win = new BrowserWindow({
    width: savedSize.width,
    height: savedSize.height,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#202225",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  win.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    const standardDevToolsShortcut =
      (process.platform === "darwin" && input.meta && input.alt && key === "i") ||
      (process.platform !== "darwin" && input.control && input.shift && key === "i");

    if (input.type === "keyDown" && standardDevToolsShortcut) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
  win.once("ready-to-show", () => {
    if (win) win.show();
  });
  win.loadFile("index.html");
  win.on("close", saveWindowSize);
  win.on("closed", () => {
    win = null;
  });
}

function sendState() {
  if (!win) return;
  win.webContents.send("state", getSerializableState());
}

function logLine(line) {
  const msg = String(line);
  stderrTail.push(msg);
  if (stderrTail.length > 200) stderrTail = stderrTail.slice(-200);
  if (win) win.webContents.send("log", msg);
}

function newGame(opts = {}) {
  const size = intOption(opts.boardSize, state.config.boardSize, 19);
  const komi = numberOption(opts.komi, state.config.komi, 7.5);
  const rules = stringOption(opts.rules, state.config.rules, "Chinese");
  const humanColor = opts.humanColor === "w" ? "w" : "b";
  const profile = stringOption(opts.humanProfile, state.config.humanProfile, "rank_5k");

  Object.assign(state.config, {
    boardSize: size,
    komi,
    rules,
    humanColor,
    humanProfile: profile
  });
  saveConfig();

  root = newNode();
  root.set("GM", "1");
  root.set("FF", "4");
  root.set("CA", "UTF-8");
  root.set("AP", "Katachi");
  root.set("SZ", String(size));
  root.set("KM", String(komi));
  root.set("RU", rules);
  root.set("DT", new Date().toISOString().slice(0, 10));

  currentNode = root;
  currentFile = "";
  dirty = false;
  pendingQuery = null;
  state.status = "New game";
  maybeEngineMove();
  sendState();
}

function intOption(value, fallback, def) {
  const n = parseInt(value, 10);
  if ([9, 13, 19].includes(n)) return n;
  if ([9, 13, 19].includes(fallback)) return fallback;
  return def;
}

function numberOption(value, fallback, def) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  if (Number.isFinite(fallback)) return fallback;
  return def;
}

function stringOption(value, fallback, def) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  return def;
}

function getEngineColor() {
  return state.config.humanColor === "b" ? "w" : "b";
}

function activeColor() {
  return currentNode.get_board().active;
}

function isHumanTurn() {
  return activeColor() === state.config.humanColor;
}

function playPoint(point) {
  if (!currentNode) return {ok: false, error: "No game"};
  if (!isHumanTurn()) return {ok: false, error: "It is KataGo's turn"};
  const board = currentNode.get_board();
  if (!board.legal_move(point, currentNode.rules_allow_self_capture())) {
    return {ok: false, error: "Illegal move"};
  }
  currentNode = currentNode.force_move(point);
  currentNode.bless();
  dirty = true;
  state.status = "Move played";
  sendState();
  maybeEngineMove();
  return {ok: true};
}

function passMove() {
  if (!currentNode) return {ok: false, error: "No game"};
  if (!isHumanTurn()) return {ok: false, error: "It is KataGo's turn"};
  currentNode = currentNode.pass();
  currentNode.bless();
  dirty = true;
  state.status = "Pass";
  sendState();
  maybeEngineMove();
  return {ok: true};
}

function undoMove() {
  if (!currentNode || !currentNode.parent) return {ok: false};
  currentNode = currentNode.parent;
  if (currentNode.parent && !isHumanTurn()) {
    currentNode = currentNode.parent;
  }
  dirty = true;
  state.status = "Undone";
  sendState();
  return {ok: true};
}

function writeDefaultAnalysisConfig() {
  const cfg = [
    "# Generated by Katachi.",
    "logDir = analysis_logs",
    "logToStderr = true",
    "logAllRequests = false",
    "logAllResponses = false",
    "logSearchInfo = false",
    "reportAnalysisWinratesAs = BLACK",
    "maxVisits = 1",
    "numAnalysisThreads = 1",
    "numSearchThreadsPerAnalysisThread = 1",
    "nnMaxBatchSize = 8",
    "nnCacheSizePowerOfTwo = 17",
    "nnMutexPoolSizePowerOfTwo = 14",
    "nnRandomize = true",
    "ignorePreRootHistory = false",
    ""
  ].join("\n");
  const cfgPath = userDataFile("analysis_human.cfg");
  fs.mkdirSync(app.getPath("userData"), {recursive: true});
  fs.writeFileSync(cfgPath, cfg);
  return cfgPath;
}

function startEngine() {
  if (engineProcess) {
    maybeEngineMove();
    return {ok: true};
  }
  if (!state.config.katagoPath || !fs.existsSync(state.config.katagoPath)) {
    return {ok: false, error: "Locate KataGo first"};
  }
  if (!state.config.humanModelPath || !fs.existsSync(state.config.humanModelPath)) {
    return {ok: false, error: "Locate the human network first"};
  }

  const cfgPath = state.config.configPath && fs.existsSync(state.config.configPath)
    ? state.config.configPath
    : writeDefaultAnalysisConfig();

  const args = [
    "analysis",
    "-config", cfgPath,
    "-model", state.config.humanModelPath,
    "-quit-without-waiting"
  ];

  stderrTail = [];
  engineReady = false;
  engineStarting = true;
  updateEngineState();

  try {
    engineProcess = childProcess.spawn(state.config.katagoPath, args, {
      cwd: app.getPath("userData"),
      windowsHide: true
    });
  } catch (err) {
    engineProcess = null;
    engineStarting = false;
    updateEngineState();
    return {ok: false, error: err.toString()};
  }

  const stdout = readline.createInterface({input: engineProcess.stdout, terminal: false});
  const stderr = readline.createInterface({input: engineProcess.stderr, terminal: false});

  stdout.on("line", receiveEngineLine);
  stderr.on("line", (line) => {
    logLine(line);
    if (line.includes("ready to begin handling requests")) {
      engineReady = true;
      engineStarting = false;
      updateEngineState();
      maybeEngineMove();
    }
  });

  engineProcess.once("error", (err) => {
    logLine(err.toString());
    stopEngineInternal();
  });

  engineProcess.once("exit", (code, signal) => {
    logLine(`KataGo exited (${code === null ? signal : code})`);
    stopEngineInternal();
  });

  sendToEngine({id: "version", action: "query_version"});
  state.status = "Starting KataGo";
  sendState();
  return {ok: true};
}

function stopEngineInternal() {
  engineProcess = null;
  engineReady = false;
  engineStarting = false;
  pendingQuery = null;
  updateEngineState();
}

function stopEngine() {
  if (engineProcess) {
    try {
      engineProcess.stdin.end();
      engineProcess.kill();
    } catch (err) {
      logLine(err.toString());
    }
  }
  stopEngineInternal();
  return {ok: true};
}

function updateEngineState() {
  state.engine.running = Boolean(engineProcess);
  state.engine.ready = engineReady;
  state.engine.starting = engineStarting;
  sendState();
}

function sendToEngine(obj) {
  if (!engineProcess) return false;
  try {
    engineProcess.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  } catch (err) {
    logLine(err.toString());
    stopEngineInternal();
    return false;
  }
}

function maybeEngineMove() {
  if (!currentNode || !engineProcess || !engineReady || pendingQuery) return;
  if (activeColor() !== getEngineColor()) return;

  const id = `move-${querySeq++}`;
  pendingQuery = {id, node: currentNode, startedAt: Date.now()};
  const query = buildQuery(currentNode, id);
  state.status = "KataGo is thinking";
  sendState();
  sendToEngine(query);
}

function receiveEngineLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (_err) {
    logLine(`Non-JSON from KataGo: ${line}`);
    return;
  }

  if (obj.id === "version") {
    engineReady = true;
    engineStarting = false;
    logLine(`KataGo ${obj.version || "started"}`);
    updateEngineState();
    maybeEngineMove();
    return;
  }

  if (obj.warning) {
    logLine(obj.warning);
    // A warning might (?) arrive attached to an actual result, in which case
    // the message must still be processed as the answer to the pending query.
    const isResult = Object.prototype.hasOwnProperty.call(obj, "turnNumber") ||
      Array.isArray(obj.moveInfos) ||
      Array.isArray(obj.policy) ||
      Array.isArray(obj.humanPolicy);
    if (!isResult) {
      if (pendingQuery && obj.id === pendingQuery.id) {
        state.status = obj.warning;
        sendState();
      }
      return;
    }
  }

  if (obj.error) {
    state.status = obj.error;
    logLine(obj.error);
    if (!obj.id || (pendingQuery && obj.id === pendingQuery.id)) {
      pendingQuery = null;
    }
    sendState();
    return;
  }

  if (!pendingQuery || obj.id !== pendingQuery.id || obj.isDuringSearch) return;

  const query = pendingQuery;
  const waitMs = Math.max(0, 1000 - (Date.now() - query.startedAt));
  setTimeout(() => applyEngineMove(query, obj), waitMs);
}

function applyEngineMove(query, result) {
  if (pendingQuery !== query) return;
  pendingQuery = null;
  if (query.node !== currentNode) return;

  const move = choosePolicyMove(result, currentNode);
  if (move === null) {
    state.status = "KataGo returned no legal move";
    sendState();
    return;
  }

  currentNode = move === "" ? currentNode.pass() : currentNode.force_move(move);
  currentNode.bless();
  dirty = true;
  state.status = move === "" ? "KataGo passed" : `KataGo played ${currentNode.get_board().gtp(move)}`;
  sendState();
}

function buildQuery(node, id) {
  const board = node.get_board();
  const query = {
    id,
    rules: node.rules() || state.config.rules || "Chinese",
    komi: node.komi(),
    boardXSize: board.width,
    boardYSize: board.height,
    maxVisits: 1,
    analysisPVLen: 1,
    includePolicy: true,
    includeOwnership: false,
    overrideSettings: {
      humanSLProfile: state.config.humanProfile || "rank_5k",
      ignorePreRootHistory: false,
      reportAnalysisWinratesAs: "BLACK",
    },
    initialStones: [],
    moves: []
  };

  for (const histNode of node.history_reversed()) {
    if (histNode.has_key("AB") || histNode.has_key("AW") || histNode.has_key("AE") || histNode.move_count() > 1) {
      query.initialStones = histNode.get_board().setup_list();
      break;
    }

    if (histNode.move_count() === 1) {
      const key = histNode.has_key("B") ? "B" : "W";
      const move = histNode.get(key);

      if (histNode.parent && histNode.parent.get_board().state_at(move)) {
        query.initialStones = histNode.get_board().setup_list();
        break;
      }

      if (query.moves.length === 0) {
        if ((key === "B" && board.active === "b") || (key === "W" && board.active === "w")) {
          query.initialStones = board.setup_list();
          break;
        }
      }

      query.moves.push([key, histNode.get_board().gtp(move)]);
    }
  }

  query.moves.reverse();
  if (query.moves.length === 0) query.initialPlayer = board.active.toUpperCase();
  return query;
}

function choosePolicyMove(result, node) {
  const board = node.get_board();
  const policy = Array.isArray(result.humanPolicy) ? result.humanPolicy : result.policy;

  if (Array.isArray(policy)) {
    const choices = [];
    const expected = board.width * board.height + 1;
    for (let i = 0; i < Math.min(policy.length, expected); i++) {
      const prior = policy[i];
      if (!(prior > 0)) continue;
      if (i === board.width * board.height) {
        choices.push({move: "", prior});
      } else {
        const x = i % board.width;
        const y = Math.floor(i / board.width);
        const move = String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
        if (board.legal_move(move, node.rules_allow_self_capture())) choices.push({move, prior});
      }
    }
    return selectPolicyMove(choices);
  }

  if (Array.isArray(result.moveInfos)) {
    const choices = [];
    for (const info of result.moveInfos) {
      const prior = info.humanPrior || info.prior;
      if (!(prior > 0)) continue;
      const rawMove = String(info.move || "");
      const move = rawMove.toLowerCase() === "pass" ? "" : board.parse_gtp_move(rawMove.toUpperCase());
      if (move === "" || board.legal_move(move, node.rules_allow_self_capture())) {
        choices.push({move, prior});
      }
    }
    return selectPolicyMove(choices);
  }

  return null;
}

function selectPolicyMove(choices) {
  if (state.config.topPolicy) return topPolicyChoice(choices);
  return weightedChoice(choices);
}

function topPolicyChoice(choices) {
  if (!choices.length) return null;
  return choices.reduce((best, item) => item.prior > best.prior ? item : best).move;
}

function weightedChoice(choices) {
  if (!choices.length) return null;
  const total = choices.reduce((sum, item) => sum + item.prior, 0);
  let r = Math.random() * total;
  for (const item of choices) {
    r -= item.prior;
    if (r <= 0) return item.move;
  }
  return choices[choices.length - 1].move;
}

function getSerializableState() {
  return {
    config: Object.assign({}, state.config),
    engine: Object.assign({}, state.engine),
    status: state.status,
    game: serializeGame()
  };
}

function serializeGame() {
  if (!currentNode) return null;
  const board = currentNode.get_board();
  const stones = [];
  for (let x = 0; x < board.width; x++) {
    for (let y = 0; y < board.height; y++) {
      if (board.state[x][y]) stones.push({x, y, color: board.state[x][y]});
    }
  }
  const last = lastMove();
  return {
    size: board.width,
    active: board.active,
    humanColor: state.config.humanColor,
    engineColor: getEngineColor(),
    humanTurn: isHumanTurn(),
    stones,
    lastMove: last,
    moveNumber: currentNode.depth,
    filename: currentFile ? path.basename(currentFile) : "",
    dirty,
    captures: {b: board.caps_by_b, w: board.caps_by_w}
  };
}

function lastMove() {
  if (!currentNode || !currentNode.parent) return null;
  if (currentNode.has_key("B")) return {color: "b", move: currentNode.get("B")};
  if (currentNode.has_key("W")) return {color: "w", move: currentNode.get("W")};
  return null;
}

async function chooseFile(kind) {
  const opts = kind === "katago"
    ? {properties: ["openFile"], filters: [{name: "KataGo", extensions: process.platform === "win32" ? ["exe"] : ["*"]}]}
    : kind === "model"
      ? {properties: ["openFile"], filters: [{name: "KataGo network", extensions: ["gz", "bin", "txt"]}, {name: "All files", extensions: ["*"]}]}
      : {properties: ["openFile"], filters: [{name: "KataGo config", extensions: ["cfg"]}, {name: "All files", extensions: ["*"]}]};
  const result = await dialog.showOpenDialog(win, opts);
  if (result.canceled || !result.filePaths.length) return "";
  return result.filePaths[0];
}

async function loadSgfDialog() {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{name: "Smart Game Format", extensions: ["sgf"]}, {name: "All files", extensions: ["*"]}]
  });
  if (result.canceled || !result.filePaths.length) return {ok: false};

  try {
    const file = result.filePaths[0];
    const loaded = loadSgf(fs.readFileSync(file));
    const roots = loaded.get_roots();
    if (!roots.length) return {ok: false, error: "No SGF game found"};
    root = roots[0];
    root.filepath = file;
    root.bless_main_line();
    currentNode = root.get_end();
    currentFile = file;
    dirty = false;
    pendingQuery = null;
    state.config.boardSize = root.width();
    state.config.komi = root.komi();
    state.config.rules = root.rules() || state.config.rules;
    saveConfig();
    state.status = "Loaded SGF";
    maybeEngineMove();
    sendState();
    return {ok: true};
  } catch (err) {
    return {ok: false, error: err.toString()};
  }
}

async function saveSgfDialog(forceAs = false) {
  if (!root) return {ok: false, error: "No game"};
  let file = forceAs ? "" : currentFile;
  if (!file) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: currentFile || "game.sgf",
      filters: [{name: "Smart Game Format", extensions: ["sgf"]}, {name: "All files", extensions: ["*"]}]
    });
    if (result.canceled || !result.filePath) return {ok: false};
    file = result.filePath;
  }

  try {
    fs.writeFileSync(file, tree_string(root), "utf8");
    currentFile = file;
    root.filepath = file;
    dirty = false;
    state.status = "Saved SGF";
    sendState();
    return {ok: true};
  } catch (err) {
    return {ok: false, error: err.toString()};
  }
}

function copySgfToClipboard() {
  if (!root) return {ok: false, error: "No game"};
  clipboard.writeText(tree_string(root));
  state.status = "Copied SGF to clipboard";
  sendState();
  return {ok: true};
}

function registerIpc() {
  ipcMain.handle("app:get-state", () => getSerializableState());
  ipcMain.handle("app:choose-katago", async () => {
    const file = await chooseFile("katago");
    if (file) {
      state.config.katagoPath = file;
      saveConfig();
      sendState();
    }
    return getSerializableState();
  });
  ipcMain.handle("app:choose-human-model", async () => {
    const file = await chooseFile("model");
    if (file) {
      state.config.humanModelPath = file;
      saveConfig();
      sendState();
    }
    return getSerializableState();
  });
  ipcMain.handle("app:choose-config", async () => {
    const file = await chooseFile("config");
    if (file) {
      state.config.configPath = file;
      saveConfig();
      sendState();
    }
    return getSerializableState();
  });
  ipcMain.handle("app:start-engine", () => startEngine());
  ipcMain.handle("app:stop-engine", () => stopEngine());
  ipcMain.handle("app:new-game", (_event, opts) => {
    newGame(opts);
    return getSerializableState();
  });
  ipcMain.handle("app:play", (_event, point) => playPoint(point));
  ipcMain.handle("app:pass", () => passMove());
  ipcMain.handle("app:undo", () => undoMove());
  ipcMain.handle("app:load-sgf", () => loadSgfDialog());
  ipcMain.handle("app:save-sgf", () => saveSgfDialog(false));
  ipcMain.handle("app:save-as-sgf", () => saveSgfDialog(true));
  ipcMain.handle("app:copy-sgf", () => copySgfToClipboard());
  ipcMain.handle("app:set-option", (_event, key, value) => {
    if (Object.prototype.hasOwnProperty.call(state.config, key)) {
      state.config[key] = value;
      saveConfig();
      if (key === "humanProfile") {
        maybeEngineMove();
      } else if (key === "topPolicy") {
        state.status = state.config.topPolicy ? "Using top policy move" : "Sampling policy";
      }
      sendState();
    }
    return getSerializableState();
  });
}

app.whenReady().then(() => {
  loadConfig();
  registerIpc();
  createWindow();
  newGame(state.config);
});

app.on("window-all-closed", () => {
  stopEngine();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
