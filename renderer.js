"use strict";

let appState = null;
let boardLayout = null;
let gridCache = null;

const boardSurface = document.getElementById("boardSurface");
const boardBg = document.getElementById("boardBg");
const boardTable = document.getElementById("boardTable");

const els = {
  engineBadge: document.getElementById("engineBadge"),
  gameTitle: document.getElementById("gameTitle"),
  turnText: document.getElementById("turnText"),
  lastMoveText: document.getElementById("lastMoveText"),
  statusLine: document.getElementById("statusLine"),
  katagoPath: document.getElementById("katagoPath"),
  humanModelPath: document.getElementById("humanModelPath"),
  configPath: document.getElementById("configPath"),
  topPolicyToggle: document.getElementById("topPolicyToggle"),
  humanColor: document.getElementById("humanColor"),
  humanProfile: document.getElementById("humanProfile"),
  boardSize: document.getElementById("boardSize"),
  komi: document.getElementById("komi"),
  rules: document.getElementById("rules")
};

function $(id) {
  return document.getElementById(id);
}

function bindControls() {
  $("chooseKatago").addEventListener("click", () => call(window.katachi.chooseKatago()));
  $("chooseHumanModel").addEventListener("click", () => call(window.katachi.chooseHumanModel()));
  $("chooseConfig").addEventListener("click", () => call(window.katachi.chooseConfig()));
  $("startEngine").addEventListener("click", () => call(window.katachi.startEngine()));
  $("stopEngine").addEventListener("click", () => call(window.katachi.stopEngine()));
  $("newGame").addEventListener("click", () => call(window.katachi.newGame(readGameOptions())));
  $("loadSgf").addEventListener("click", () => call(window.katachi.loadSgf()));
  $("saveSgf").addEventListener("click", () => call(window.katachi.saveSgf()));
  $("saveAsSgf").addEventListener("click", () => call(window.katachi.saveAsSgf()));
  $("copySgf").addEventListener("click", () => call(window.katachi.copySgf()));
  $("undoMove").addEventListener("click", () => call(window.katachi.undo()));
  $("passMove").addEventListener("click", () => call(window.katachi.pass()));
  $("topPolicyToggle").addEventListener("click", () => {
    const nextValue = !Boolean(appState && appState.config && appState.config.topPolicy);
    call(window.katachi.setOption("topPolicy", nextValue));
  });

  for (const [key, el] of Object.entries({
    humanColor: els.humanColor,
    humanProfile: els.humanProfile,
    boardSize: els.boardSize,
    komi: els.komi,
    rules: els.rules
  })) {
    el.addEventListener("change", () => {
      window.katachi.setOption(key, el.value);
    });
  }

  window.addEventListener("resize", drawBoard);
}

function readGameOptions() {
  return {
    humanColor: els.humanColor.value,
    humanProfile: els.humanProfile.value,
    boardSize: els.boardSize.value,
    komi: els.komi.value,
    rules: els.rules.value
  };
}

async function call(promise) {
  try {
    const result = await promise;
    if (result && result.error) showStatus(result.error);
    if (result && result.game) render(result);
  } catch (err) {
    showStatus(err.toString());
  }
}

function render(state) {
  appState = state;
  const cfg = state.config;
  const game = state.game;

  els.humanColor.value = cfg.humanColor || "b";
  els.humanProfile.value = cfg.humanProfile || "rank_5k";
  els.boardSize.value = String(cfg.boardSize || 19);
  els.komi.value = String(cfg.komi ?? 7.5);
  els.rules.value = cfg.rules || "Chinese";

  els.katagoPath.textContent = cfg.katagoPath || "Not set";
  els.humanModelPath.textContent = cfg.humanModelPath || "Not set";
  els.configPath.textContent = cfg.configPath || "Generated";
  els.topPolicyToggle.classList.toggle("on", Boolean(cfg.topPolicy));
  els.topPolicyToggle.setAttribute("aria-pressed", cfg.topPolicy ? "true" : "false");

  els.engineBadge.textContent = state.engine.ready
    ? "Engine ready"
    : state.engine.starting
      ? "Engine starting"
      : state.engine.running
        ? "Engine running"
        : "Engine stopped";
  els.engineBadge.className = state.engine.ready ? "badge ready" : state.engine.running ? "badge starting" : "badge";

  if (game) {
    const dirty = game.dirty ? "*" : "";
    els.gameTitle.textContent = game.filename ? `${game.filename}${dirty}` : `New game${dirty}`;
    els.turnText.textContent = `${nameColor(game.active)} to play (${game.humanTurn ? "human" : "KataGo"})`;
    els.lastMoveText.textContent = formatLastMove(game.lastMove, game.size);
  }

  showStatus(state.status || "");
  drawBoard();
}

function showStatus(text) {
  els.statusLine.textContent = text || "";
}

function formatLastMove(last, size) {
  if (!last) return "";
  if (!last.move) return `${nameColor(last.color)} passed`;
  const x = last.move.charCodeAt(0) - 97;
  const y = last.move.charCodeAt(1) - 97;
  return `${nameColor(last.color)} ${gtpFromXY(x, y, size)}`;
}

function nameColor(color) {
  return color === "b" ? "Black" : "White";
}

function gtpFromXY(x, y, size) {
  const letter = String.fromCharCode(65 + x + (x >= 8 ? 1 : 0));
  return `${letter}${size - y}`;
}

function drawBoard() {
  if (!appState || !appState.game) return;

  const game = appState.game;
  const size = game.size;
  const wrap = document.getElementById("boardWrap");
  const side = Math.max(260, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
  const cellSize = Math.max(18, Math.floor(side / (size + 1)));
  const surfaceSize = cellSize * (size + 1);

  boardLayout = {size, cellSize};
  boardSurface.style.width = `${surfaceSize}px`;
  boardSurface.style.height = `${surfaceSize}px`;
  boardBg.style.width = `${surfaceSize}px`;
  boardBg.style.height = `${surfaceSize}px`;

  if (!gridCache || gridCache.cellSize !== cellSize) {
    gridCache = makeGridImages(cellSize, 1, "#24180b");
  }

  rebuildBoardTable(game, cellSize);
}

function rebuildBoardTable(game, cellSize) {
  const size = game.size;
  const stones = new Map();
  for (const stone of game.stones) {
    stones.set(`${stone.x},${stone.y}`, stone.color);
  }

  boardTable.replaceChildren();

  for (let y = 0; y <= size; y++) {
    const tr = document.createElement("tr");
    boardTable.appendChild(tr);
    for (let x = 0; x <= size; x++) {
      const td = document.createElement("td");
      td.style.width = `${cellSize}px`;
      td.style.height = `${cellSize}px`;

      if (x === 0 && y < size) {
        td.className = "coord";
        td.textContent = String(size - y);
      } else if (x > 0 && y === size) {
        td.className = "coord";
        td.textContent = "ABCDEFGHJKLMNOPQRSTUVWXYZ"[x - 1];
      } else if (x === 0 && y === size) {
        td.className = "coord";
      } else {
        const bx = x - 1;
        const by = y;
        const key = `${bx},${by}`;
        const stone = stones.get(key);
        td.className = `point td_${pointFromXY(bx, by)}`;
        td.dataset.point = pointFromXY(bx, by);
        td.addEventListener("click", onPointClick);

        if (stone) {
          td.style.backgroundImage = `url("gfx/${stone === "b" ? "black_stone" : "white_stone"}.png")`;
        } else {
          td.style.backgroundImage = `url("${gridImageFor(bx, by, size)}")`;
        }

        if (isLastMove(game.lastMove, bx, by)) {
          const mark = document.createElement("span");
          mark.className = `lastMarker ${game.lastMove.color === "b" ? "onBlack" : "onWhite"}`;
          td.appendChild(mark);
        }
      }
      tr.appendChild(td);
    }
  }
}

function onPointClick(event) {
  if (!appState || !appState.game || !appState.game.humanTurn) return;
  const point = event.currentTarget.dataset.point;
  if (point) call(window.katachi.play(point));
}

function pointFromXY(x, y) {
  return String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
}

function isLastMove(last, x, y) {
  if (!last || !last.move) return false;
  return last.move === pointFromXY(x, y);
}

function gridImageFor(x, y, size) {
  if (isStarPoint(x, y, size)) return gridCache.hoshi;
  if (x === 0 && y === 0) return gridCache.topleft;
  if (x === size - 1 && y === 0) return gridCache.topright;
  if (x === 0 && y === size - 1) return gridCache.bottomleft;
  if (x === size - 1 && y === size - 1) return gridCache.bottomright;
  if (x === 0) return gridCache.left;
  if (x === size - 1) return gridCache.right;
  if (y === 0) return gridCache.top;
  if (y === size - 1) return gridCache.bottom;
  return gridCache.mid;
}

function isStarPoint(x, y, size) {
  return starPoints(size).some(([sx, sy]) => sx === x && sy === y);
}

function starPoints(size) {
  if (size === 19) return [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]];
  if (size === 13) return [[3, 3], [6, 3], [9, 3], [3, 6], [6, 6], [9, 6], [3, 9], [6, 9], [9, 9]];
  if (size === 9) return [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]];
  return [];
}

function makeGridImages(cellSize, lineWidth, colour) {
  const source = document.createElement("canvas");
  const sourceCtx = source.getContext("2d", {willReadFrequently: true});
  const dest = document.createElement("canvas");
  const destCtx = dest.getContext("2d", {willReadFrequently: true});

  source.width = cellSize * 3;
  source.height = cellSize * 3;
  sourceCtx.lineWidth = lineWidth;
  sourceCtx.strokeStyle = colour;
  sourceCtx.fillStyle = colour;

  const offset = ((lineWidth + cellSize) % 2 === 1) ? 0.5 : 0;
  for (let x = 0; x < 3; x++) {
    const x1 = (x * cellSize) + (cellSize / 2) + offset;
    sourceCtx.beginPath();
    sourceCtx.moveTo(x1, cellSize / 2 + offset);
    sourceCtx.lineTo(x1, (3 * cellSize) - (cellSize / 2) + offset);
    sourceCtx.stroke();
  }
  for (let y = 0; y < 3; y++) {
    const y1 = (y * cellSize) + (cellSize / 2) + offset;
    sourceCtx.beginPath();
    sourceCtx.moveTo(cellSize / 2 + offset, y1);
    sourceCtx.lineTo((3 * cellSize) - (cellSize / 2) + offset, y1);
    sourceCtx.stroke();
  }

  const ret = {
    cellSize,
    topleft: sliceGrid(sourceCtx, dest, destCtx, 0, 0, cellSize),
    top: sliceGrid(sourceCtx, dest, destCtx, 1, 0, cellSize),
    topright: sliceGrid(sourceCtx, dest, destCtx, 2, 0, cellSize),
    left: sliceGrid(sourceCtx, dest, destCtx, 0, 1, cellSize),
    mid: sliceGrid(sourceCtx, dest, destCtx, 1, 1, cellSize),
    right: sliceGrid(sourceCtx, dest, destCtx, 2, 1, cellSize),
    bottomleft: sliceGrid(sourceCtx, dest, destCtx, 0, 2, cellSize),
    bottom: sliceGrid(sourceCtx, dest, destCtx, 1, 2, cellSize),
    bottomright: sliceGrid(sourceCtx, dest, destCtx, 2, 2, cellSize)
  };

  const gx = cellSize + (cellSize / 2) + offset;
  const gy = cellSize + (cellSize / 2) + offset;
  sourceCtx.beginPath();
  sourceCtx.arc(gx, gy, lineWidth + 2, 0, 3 * Math.PI);
  sourceCtx.fill();
  ret.hoshi = sliceGrid(sourceCtx, dest, destCtx, 1, 1, cellSize);
  return ret;
}

function sliceGrid(sourceCtx, dest, destCtx, x, y, cellSize) {
  const data = sourceCtx.getImageData(x * cellSize, y * cellSize, cellSize, cellSize);
  dest.width = cellSize;
  dest.height = cellSize;
  destCtx.putImageData(data, 0, 0);
  return dest.toDataURL("image/png");
}

window.katachi.onState(render);
window.katachi.onLog((line) => {
  console.log(line);
});

bindControls();
window.katachi.getState().then(render);
