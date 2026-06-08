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
 *   {"n": 8, "cmd": "title", "value": "別の作品 第2話"}  // 視聴中タイトルを変更（SPA話数遷移を模擬）
 *   {"n": 9, "cmd": "episode", "value": "SID0234926/ED00720092"} // 次エピソードへ遷移（contentKey 切替＋先頭から再生）
 *
 * 視聴中エピソード(contentKey)の初期値は HOST_CONTENT_KEY env で設定（既定 SID0234926/ED00720091）。
 * 参加者の実 U-NEXT URL の SID/ED に一致させること（不一致だと参加者は hold＝同期されない）。
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
const SERVER_URL = process.env.SERVER_URL || "ws://localhost:8787";
const HTTP_BASE = SERVER_URL.replace(/^ws/, "http"); // ws→http, wss→https（POST /create 用）
const HOST_NAME = "ホスト(擬似)"; // roster に表示されるホスト名
const HOST_TITLE = "テスト作品 第1話"; // 視聴中タイトル（参加者popupに「🎬 視聴中: …」で表示）
const HEARTBEAT_INTERVAL_MS = 5000;
const TICKER_INTERVAL_MS = 100;     // currentTime 追跡精度
const CONTROL_POLL_MS = 200;
const INITIAL_CURRENT_TIME = 60.0;  // 1:00 から開始（動画は5分以上のものを用意）
// 視聴中エピソード識別子（SID/ED）。実拡張では deriveContentKey(location.pathname) が導く値。
// 参加者の実 U-NEXT URL の SID/ED に一致させること（一致しないと参加者は hold＝同期されない）。
// 既定はリクエスト例の第1話。テスターが開く作品に合わせ HOST_CONTENT_KEY で上書きする。
const INITIAL_CONTENT_KEY = process.env.HOST_CONTENT_KEY || "SID0234926/ED00720091";

// ── 内部再生モデル ───────────────────────────────────────────────────────────
const state = {
  playing: false,
  currentTime: INITIAL_CURRENT_TIME,
  playbackRate: 1.0,
  seq: 0,
};
let currentTitle = HOST_TITLE; // ホストが送信中の視聴タイトル（title コマンドで変更可）
let currentContentKey = INITIAL_CONTENT_KEY; // ホストが視聴中のエピソード（episode コマンドで変更可）

// ── セッション状態 ──────────────────────────────────────────────────────────
let ws = null;
let roomId = null;
let hostToken = null;
let hostJoined = false;
let lastControlN = -1; // 起動直後に制御ファイルの現在値で基準化する（下の setInterval 直前）。
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
    v: 2,
    type: "sync",
    event,
    playing: state.playing,
    currentTime: Number(state.currentTime.toFixed(3)),
    playbackRate: state.playbackRate,
    seq: state.seq,
    contentKey: currentContentKey,
  };
  send(msg);
  log("SYNC", `${event.padEnd(11)} t=${msg.currentTime.toFixed(1)}s rate=${state.playbackRate}x playing=${state.playing} seq=${state.seq} ck=${currentContentKey}`);
}

// ── 視聴中タイトル送信（host→server。サーバーが room_title で全員へ配信） ──────
function sendTitle(title) {
  currentTitle = title;
  send({ v: 2, type: "title", title });
  log("TITLE", `→ "${title}"`);
}

// ── ルーム作成（HTTP POST /create） ────────────────────────────────────────
async function ensureRoom() {
  if (roomId) return;
  log("ACTION", `POST ${HTTP_BASE}/create ...`);
  const res = await fetch(`${HTTP_BASE}/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  const data = await res.json();
  roomId = data.roomId;
  hostToken = data.hostToken;
  log("RECV", `created → roomId=${roomId}`);
}

// ── WS接続 ─────────────────────────────────────────────────────────────────
function connect() {
  log("CONNECT", `→ ${SERVER_URL}/r/${roomId}`);
  ws = new WebSocket(`${SERVER_URL}/r/${roomId}`, [SECRET]);

  ws.on("open", () => {
    log("OPEN", "Connected");
    log("ACTION", `Joining room ${roomId} as host (hostToken=${hostToken.slice(0, 8)}...)`);
    send({ v: 2, type: "join", roomId, role: "host", hostToken, name: HOST_NAME });
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
          // 視聴中タイトルを送る（実拡張では content.ts が joined(host) で送出）。
          // 再接続時もここを通るので resend され、サーバーが同値なら弾く。
          sendTitle(currentTitle);
        } else {
          log("RECV", `joined as ${msg.role} (host slot was taken?)`);
        }
        break;

      case "host_taken":
        log("RECV", "host_taken — host slot occupied by another client");
        break;

      case "roster": {
        // 参加者の入退室・ホスト切断/復帰のたびにサーバーが全ロスターを送る（方式C / 全状態スナップショット）
        const rows = (msg.participants ?? [])
          .map((p) => `${p.host ? "👑" : "・"}${p.name}${p.connected ? "" : "(切断)"}`)
          .join("  ");
        log("ROSTER", `(${msg.participants?.length ?? 0}) ${rows}`);
        break;
      }

      case "room_title":
        // ホスト本人にも自分の room_title が返る（broadcast は全員宛）。配信確認用。
        log("RECVTTL", `room_title → "${msg.title}"`);
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

// 起動時点で制御ファイルに残っている n を基準にする。これをしないと、前回セッションの
// コマンド（例: コミット済み既定や直前の disconnect/reconnect）が起動直後に発火し、
// 意図しないホスト再接続などのアーティファクトを生む。基準化後はインクリメントだけに反応する。
{
  const initial = readControl();
  if (initial && typeof initial.n === "number") lastControlN = initial.n;
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

    case "title":
      if (typeof value === "string" && value.trim() !== "") {
        sendTitle(value);
      } else {
        log("ERROR", "title requires a non-empty string value");
      }
      break;

    case "episode":
      // 次エピソードへの自動遷移を模擬。host の contentKey を切り替え、新エピソード先頭から再生する。
      // 実拡張では content.ts が遷移検知で <video> を取り直し orchestrator.heartbeat() を即送出する箇所に対応。
      // 参加者は自分の URL の SID/ED がこの値に一致するまで hold（誤シークしない）。
      if (typeof value === "string" && /^SID\w+\/ED\w+$/.test(value)) {
        currentContentKey = value;
        state.currentTime = 0; // 新エピソードは先頭から
        emitSync("heartbeat"); // 新 contentKey＋新 currentTime を即時通知（ズレ窓を最小化）
        log("ACTION", `Episode → ${value}（currentTime を 0 にリセット）`);
      } else {
        log("ERROR", 'episode requires value like "SID0234926/ED00720092"');
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
      console.log(`  title       : "${currentTitle}"`);
      console.log(`  contentKey  : ${currentContentKey}`);
      console.log("────────────────────────────────────────────────────\n");
      break;

    default:
      log("WARN", `Unknown command: "${cmd}"`);
      break;
  }
}, CONTROL_POLL_MS);

// ── 起動 ───────────────────────────────────────────────────────────────────
log("START", `E2E Pseudo-Host — currentTime starts at ${INITIAL_CURRENT_TIME}s`);
log("START", `contentKey = ${currentContentKey}（参加者の U-NEXT URL の SID/ED に一致させること）`);
log("START", `Control file: ${CONTROL_FILE}`);
ensureRoom()
  .then(connect)
  .catch((e) => {
    log("ERROR", `startup failed: ${e.message}`);
    process.exit(1);
  });
