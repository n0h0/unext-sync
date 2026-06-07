/**
 * e2e-host.mjs — E2Eテスト用擬似ホスト
 *
 * U-NEXTを実ブラウザで開いた参加者に対し、このスクリプトがホストとして
 * 再生状態（play/pause/seek/rate）を送信する。
 * 動画データは一切送らない（Watch Sync 方式C）。
 *
 * 起動: CONNECT_SECRET=<hex32> node scripts/e2e-host.mjs
 *
 * 制御: scripts/e2e-control.json の `n` をインクリメントしてコマンドを渡す。
 *   {"n": 1, "cmd": "play"}
 *   {"n": 2, "cmd": "seek", "value": 90}
 *   {"n": 3, "cmd": "pause"}
 *   {"n": 4, "cmd": "rate", "value": 1.5}
 *   {"n": 5, "cmd": "disconnect"}
 *   {"n": 6, "cmd": "reconnect"}
 *   {"n": 7, "cmd": "status"}
 */

import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTROL_FILE = join(__dirname, "e2e-control.json");

// ── 起動チェック ────────────────────────────────────────────────────────────
const SECRET = process.env.CONNECT_SECRET;
if (!SECRET || !/^[A-Za-z0-9_-]+$/.test(SECRET)) {
  console.error("ERROR: CONNECT_SECRET is unset or not token-safe (hex32 required).");
  console.error("  Hint: CONNECT_SECRET=$(openssl rand -hex 32) node scripts/e2e-host.mjs");
  process.exit(1);
}

// ── 定数 ───────────────────────────────────────────────────────────────────
const SERVER_URL = "ws://localhost:8080";
const HEARTBEAT_INTERVAL_MS = 5000;
const TICKER_INTERVAL_MS = 100;     // currentTime 追跡精度
const CONTROL_POLL_MS = 200;
const INITIAL_CURRENT_TIME = 60.0;  // 1:00 から開始（動画は5分以上のものを用意）

// ── 内部再生モデル ───────────────────────────────────────────────────────────
const state = {
  playing: false,
  currentTime: INITIAL_CURRENT_TIME,
  playbackRate: 1.0,
  seq: 0,
};

// ── セッション状態 ──────────────────────────────────────────────────────────
let ws = null;
let roomId = null;
let hostToken = null;
let hostJoined = false;
let lastControlN = -1;
let lastTickMs = null;

// ── ロギング ────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}
function log(tag, ...args) {
  console.log(`[${ts()}] [${tag.padEnd(8)}]`, ...args);
}

// ── メッセージ送信 ──────────────────────────────────────────────────────────
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    log("WARN", "Cannot send — socket not open");
  }
}

function emitSync(event) {
  state.seq++;
  const msg = {
    v: 1,
    type: "sync",
    event,
    playing: state.playing,
    currentTime: Number(state.currentTime.toFixed(3)),
    playbackRate: state.playbackRate,
    seq: state.seq,
  };
  send(msg);
  log("SYNC", `${event.padEnd(11)} t=${msg.currentTime.toFixed(1)}s rate=${state.playbackRate}x playing=${state.playing} seq=${state.seq}`);
}

// ── WS接続 ─────────────────────────────────────────────────────────────────
function connect() {
  log("CONNECT", `→ ${SERVER_URL}`);
  ws = new WebSocket(SERVER_URL, [SECRET]);

  ws.on("open", () => {
    log("OPEN", "Connected");
    if (!roomId) {
      log("ACTION", "Sending create...");
      send({ v: 1, type: "create" });
    } else {
      // 再接続: 既存トークンでhostとして再join
      log("ACTION", `Re-joining room ${roomId} as host (hostToken=${hostToken.slice(0, 8)}...)`);
      send({ v: 1, type: "join", roomId, role: "host", hostToken });
    }
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log("ERROR", "Bad JSON from server:", data.toString());
      return;
    }

    switch (msg.type) {
      case "created":
        roomId = msg.roomId;
        hostToken = msg.hostToken;
        log("RECV", `created → roomId=${roomId}`);
        send({ v: 1, type: "join", roomId, role: "host", hostToken });
        break;

      case "joined":
        if (msg.role === "host") {
          hostJoined = true;
          lastTickMs = performance.now();
          log("RECV", "joined as HOST ✓");
          console.log("\n" + "═".repeat(60));
          console.log(`  🎬  ROOM ID: ${roomId}`);
          console.log(`  参加者はこのIDをpopupに入力し「参加」ボタンを押してください`);
          console.log("═".repeat(60) + "\n");
          // 初回heartbeat（lastState を即座に確立）
          emitSync("heartbeat");
        } else {
          log("RECV", `joined as ${msg.role} (host slot was taken?)`);
        }
        break;

      case "host_taken":
        log("RECV", "host_taken — host slot occupied by another client");
        break;

      case "pong":
        // RTT確認用（正常動作）
        break;

      default:
        log("RECV", JSON.stringify(msg));
    }
  });

  ws.on("close", (code, reason) => {
    hostJoined = false;
    log("CLOSE", `code=${code} reason=${reason || "(none)"}`);
  });

  ws.on("error", (err) => {
    log("ERROR", err.message);
  });
}

// ── currentTime を進めるティッカー ──────────────────────────────────────────
setInterval(() => {
  if (!hostJoined || lastTickMs === null) return;
  const now = performance.now();
  const elapsedSec = (now - lastTickMs) / 1000;
  lastTickMs = now;
  if (state.playing) {
    state.currentTime += elapsedSec * state.playbackRate;
  }
}, TICKER_INTERVAL_MS);

// ── heartbeat（方式C: 5秒ごとに全状態スナップショット送信） ──────────────
setInterval(() => {
  if (!hostJoined) return;
  emitSync("heartbeat");
}, HEARTBEAT_INTERVAL_MS);

// ── コントロールファイルのポーリング ────────────────────────────────────────
function readControl() {
  try {
    return JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
  } catch {
    return null;
  }
}

setInterval(() => {
  const ctrl = readControl();
  if (!ctrl || typeof ctrl.n !== "number" || ctrl.n <= lastControlN) return;
  lastControlN = ctrl.n;

  const cmd = (ctrl.cmd ?? "").trim();
  const value = ctrl.value;
  log("CTRL", `→ cmd="${cmd}"${value !== undefined ? ` value=${value}` : ""}`);

  switch (cmd) {
    case "play":
      state.playing = true;
      emitSync("play");
      break;

    case "pause":
      state.playing = false;
      emitSync("pause");
      break;

    case "seek":
      if (typeof value === "number" && value >= 0) {
        state.currentTime = value;
        emitSync("seek");
      } else {
        log("ERROR", "seek requires numeric value >= 0");
      }
      break;

    case "rate":
      if (typeof value === "number" && value > 0) {
        state.playbackRate = value;
        emitSync("ratechange");
      } else {
        log("ERROR", "rate requires numeric value > 0");
      }
      break;

    case "disconnect":
      log("ACTION", "Simulating host disconnect (close socket)...");
      if (ws) ws.close(1000, "manual-disconnect");
      break;

    case "reconnect":
      log("ACTION", "Reconnecting as host...");
      connect();
      break;

    case "status":
      console.log("\n── STATUS ──────────────────────────────────────────");
      console.log(`  roomId      : ${roomId ?? "(none)"}`);
      console.log(`  hostJoined  : ${hostJoined}`);
      console.log(`  playing     : ${state.playing}`);
      console.log(`  currentTime : ${state.currentTime.toFixed(2)}s`);
      console.log(`  playbackRate: ${state.playbackRate}x`);
      console.log(`  seq         : ${state.seq}`);
      console.log("────────────────────────────────────────────────────\n");
      break;

    default:
      log("WARN", `Unknown command: "${cmd}"`);
      break;
  }
}, CONTROL_POLL_MS);

// ── 起動 ───────────────────────────────────────────────────────────────────
log("START", `E2E Pseudo-Host — currentTime starts at ${INITIAL_CURRENT_TIME}s`);
log("START", `Control file: ${CONTROL_FILE}`);
connect();
