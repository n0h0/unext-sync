/**
 * e2e-observer.mjs — E2Eテスト用 擬似参加者オブザーバ
 *
 * 実ブラウザがホストになって U-NEXT を再生する「ホスト側実機テスト」用。
 * このスクリプトは participant として既存ルームに join し、ホストから配信される
 * 全メッセージ（state / roster / room_title / host_*）をタイムスタンプ付き1行ログで
 * 流し続ける。動画データは一切受け取らない（Watch Sync 方式C）。
 *
 * e2e-host.mjs（擬似ホスト）の対。あちらは「擬似ホスト ↔ 実ブラウザ参加者」、
 * こちらは「実ブラウザホスト ↔ 擬似参加者オブザーバ」。
 *
 * 起動: ROOM_ID=<実ブラウザの popup が表示した roomId> \
 *         CONNECT_SECRET=<hex32> node scripts/e2e-observer.mjs
 *
 *   # 接続先の既定はローカル wrangler dev。本番はホストの拡張ビルドと同じ URL を指定:
 *   SERVER_URL=wss://unext-sync.<subdomain>.workers.dev ROOM_ID=<id> CONNECT_SECRET=<hex> node scripts/e2e-observer.mjs
 *
 * NAME env で roster 表示名を変更可（既定「オブザーバ(擬似)」）。
 *
 * ── 受動アサート（人間の目視照合を補助。操作の正否判定は人間が行う） ──
 *   [WARN] が出る条件:
 *   - state のスキーマ不正（playing/currentTime/playbackRate/seq/event が protocol 不適合）
 *   - seq 後退（同一ホストの単調増加が崩れた / 受信順序の乱れ）。ただしホスト再接続では
 *     seq が 0 起点にリセットされる既知制約（spec §11）があり、その場合は [INFO] で再起点を示す。
 *   - heartbeat 間隔の逸脱（前回 state から HEARTBEAT_WARN_MS 超）。背景タブのタイマー
 *     スロットリングでも出うるため、ホストタブを前面にして観測すること。
 */

import { WebSocket } from "ws";

// ── 起動チェック ────────────────────────────────────────────────────────────
const SECRET = process.env.CONNECT_SECRET;
if (!SECRET || !/^[A-Za-z0-9_-]+$/.test(SECRET)) {
  console.error("ERROR: CONNECT_SECRET is unset or not token-safe (hex required).");
  console.error("  Hint: ROOM_ID=<id> CONNECT_SECRET=$(your secret) node scripts/e2e-observer.mjs");
  process.exit(2);
}
const ROOM_ID = process.env.ROOM_ID;
if (!ROOM_ID) {
  console.error("ERROR: ROOM_ID is unset.");
  console.error("  実ブラウザの拡張 popup で「ルーム作成」して表示された roomId を渡す:");
  console.error("  ROOM_ID=<id> CONNECT_SECRET=<hex> node scripts/e2e-observer.mjs");
  process.exit(2);
}

// ── 定数 ───────────────────────────────────────────────────────────────────
const SERVER_URL = process.env.SERVER_URL || "ws://localhost:8787";
const NAME = process.env.NAME || "オブザーバ(擬似)";
const PROTOCOL_VERSION = 2;
const HEARTBEAT_MS = 5000; // shared/sync-core.ts DEFAULTS.heartbeatMs と一致
const HEARTBEAT_WARN_MS = 8000; // この間隔を超えて state が来なければ WARN（5s 想定＋余裕）
const SYNC_EVENTS = new Set(["play", "pause", "seek", "ratechange", "heartbeat"]);

// ── 観測状態 ────────────────────────────────────────────────────────────────
let lastSeq = null; // 直近に観測した state.seq（後退検出用）
let lastStateMs = null; // 直近に state を受信した壁時計（heartbeat 間隔監視用）

// ── ロギング ────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}
function log(tag, ...args) {
  console.log(`[${ts()}] [${tag.padEnd(8)}]`, ...args);
}

// ── state スキーマ検証（shared/protocol.ts の isPlayback / isSyncEvent と等価） ──
function validateState(m) {
  const problems = [];
  if (m.v !== PROTOCOL_VERSION) problems.push(`v=${m.v}`);
  if (!SYNC_EVENTS.has(m.event)) problems.push(`event=${m.event}`);
  if (typeof m.playing !== "boolean") problems.push(`playing=${m.playing}`);
  if (!Number.isFinite(m.currentTime) || m.currentTime < 0) problems.push(`currentTime=${m.currentTime}`);
  if (!Number.isFinite(m.playbackRate) || m.playbackRate <= 0) problems.push(`playbackRate=${m.playbackRate}`);
  if (!Number.isInteger(m.seq)) problems.push(`seq=${m.seq}`);
  return problems;
}

function onState(m) {
  const nowMs = Date.now();

  // スキーマ検証
  const problems = validateState(m);
  if (problems.length > 0) {
    log("WARN", `state スキーマ不正: ${problems.join(", ")} — raw=${JSON.stringify(m)}`);
  }

  // seq 後退検出（再接続による 0 起点リセットは既知制約として INFO で区別）
  if (lastSeq !== null && Number.isInteger(m.seq)) {
    if (m.seq <= lastSeq) {
      if (m.seq <= 1) {
        log("INFO", `seq 再起点 ${lastSeq} → ${m.seq}（ホスト再接続/リロードの既知制約 spec §11 と整合）`);
      } else {
        log("WARN", `seq 後退 ${lastSeq} → ${m.seq}（受信順序の乱れ・重複の疑い）`);
      }
    }
  }
  lastSeq = Number.isInteger(m.seq) ? m.seq : lastSeq;

  // heartbeat 間隔監視（前回 state からの経過）
  if (lastStateMs !== null) {
    const gap = nowMs - lastStateMs;
    if (gap > HEARTBEAT_WARN_MS) {
      log(
        "WARN",
        `state 間隔 ${(gap / 1000).toFixed(1)}s > ${(HEARTBEAT_WARN_MS / 1000).toFixed(0)}s（heartbeat 欠落の疑い。ホストタブが背景だとタイマー抑制で出うる）`,
      );
    }
  }
  lastStateMs = nowMs;

  // 生ログ（1行整形）
  const t = Number.isFinite(m.currentTime) ? m.currentTime.toFixed(1) : m.currentTime;
  log(
    "STATE",
    `${String(m.event).padEnd(11)} playing=${m.playing} t=${t}s rate=${m.playbackRate}x seq=${m.seq} ck=${m.contentKey ?? "(none)"}`,
  );
}

// ── WS接続 ─────────────────────────────────────────────────────────────────
const url = `${SERVER_URL}/r/${ROOM_ID}`;
log("START", `観測開始 — ${url}`);
log("START", `name="${NAME}" / heartbeat 想定 ${HEARTBEAT_MS / 1000}s, WARN 閾値 ${HEARTBEAT_WARN_MS / 1000}s`);

const ws = new WebSocket(url, [SECRET]);

ws.on("open", () => {
  log("OPEN", "Connected");
  log("ACTION", `Joining room ${ROOM_ID} as participant (name="${NAME}")`);
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", roomId: ROOM_ID, role: "participant", name: NAME }));
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
      log("RECV", `joined as ${msg.role} ✓ clientId=${msg.clientId}`);
      break;

    case "state":
      onState(msg);
      break;

    case "roster": {
      const rows = (msg.participants ?? [])
        .map((p) => `${p.host ? "👑" : "・"}${p.name}${p.connected ? "" : "(切断)"}`)
        .join("  ");
      log("ROSTER", `(${msg.participants?.length ?? 0}) ${rows}`);
      break;
    }

    case "room_title":
      log("TITLE", `room_title → "${msg.title}"`);
      break;

    case "host_disconnected":
      log("RECV", "host_disconnected — ホストが切断（60秒スロット保持中）");
      break;

    case "host_resumed":
      log("RECV", "host_resumed — ホストが復帰");
      break;

    case "no_room":
      log("WARN", "no_room — ルームが存在しない（roomId 誤り / 期限切れ）。終了する。");
      ws.close();
      break;

    case "pong":
      break; // RTT 用、ノイズなので無視

    default:
      log("RECV", JSON.stringify(msg));
  }
});

ws.on("close", (code, reason) => {
  log("CLOSE", `code=${code} reason=${reason || "(none)"}`);
  process.exit(0);
});

ws.on("error", (err) => {
  log("ERROR", err.message);
});
