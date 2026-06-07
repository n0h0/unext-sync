/**
 * e2e-prod-smoke.mjs — 本番 Worker(+DO) の WS 同期リレーをヘッドレスで検証する E2E スモーク。
 *
 * 実ブラウザ参加者を使わず、host と participant の両方を Node から接続して
 * 「ホストの sync が参加者へ伝播するか」「途中参加者が lastState を受け取るか」
 * 「ホスト切断/復帰が通知されるか」「ping/pong」までを実デプロイに対して検証する。
 *
 * 実行:
 *   CONNECT_SECRET=<hex32> node scripts/e2e-prod-smoke.mjs
 *   # 既定の接続先は本番。別環境は SERVER_URL で上書き（例: ローカル）:
 *   SERVER_URL=ws://localhost:8787 CONNECT_SECRET=<hex32> node scripts/e2e-prod-smoke.mjs
 */

import { WebSocket } from "ws";

const SECRET = process.env.CONNECT_SECRET;
if (!SECRET || !/^[A-Za-z0-9_-]+$/.test(SECRET)) {
  console.error("ERROR: CONNECT_SECRET is unset or not token-safe (hex required).");
  console.error("  Run: CONNECT_SECRET=$(your secret) node scripts/e2e-prod-smoke.mjs");
  process.exit(2);
}
const SERVER_URL = process.env.SERVER_URL ?? "wss://unext-sync.kusakatsubasa-dba.workers.dev";
const HTTP_BASE = SERVER_URL.replace(/^ws/, "http");
const V = 2;

let pass = 0;
let fail = 0;
function ok(name) {
  pass++;
  console.log(`  ✅ ${name}`);
}
function bad(name, detail) {
  fail++;
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WS を開いて { ws, msgs(配列), waitFor(predicate, timeoutMs) } を返す。 */
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [SECRET]);
    const msgs = [];
    const timer = setTimeout(() => reject(new Error(`open timeout: ${url}`)), 10000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        msgs,
        send: (m) => ws.send(JSON.stringify(m)),
        waitFor: (pred, timeoutMs = 8000) =>
          new Promise((res, rej) => {
            const found = msgs.find(pred);
            if (found) return res(found);
            const to = setTimeout(() => rej(new Error("waitFor timeout")), timeoutMs);
            const onMsg = (data) => {
              let m;
              try {
                m = JSON.parse(data.toString());
              } catch {
                return;
              }
              if (pred(m)) {
                clearTimeout(to);
                ws.off("message", onMsg);
                res(m);
              }
            };
            ws.on("message", onMsg);
          }),
      });
    });
    ws.on("message", (data) => {
      try {
        msgs.push(JSON.parse(data.toString()));
      } catch {}
    });
    ws.on("error", (e) => reject(e));
  });
}

async function main() {
  console.log(`\n🌐 E2E prod smoke → ${SERVER_URL}\n`);

  // 1. HTTP create
  const createRes = await fetch(`${HTTP_BASE}/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (!createRes.ok) {
    bad("POST /create", `status ${createRes.status}`);
    return;
  }
  const { roomId, hostToken } = await createRes.json();
  if (roomId && hostToken) ok(`POST /create → roomId=${roomId}`);
  else return bad("POST /create", "missing roomId/hostToken");

  // 2. host join
  const host = await open(`${SERVER_URL}/r/${roomId}`);
  host.send({ v: V, type: "join", roomId, role: "host", hostToken, name: "smoke-host" });
  try {
    await host.waitFor((m) => m.type === "joined" && m.role === "host");
    ok("host joined as host");
  } catch {
    return bad("host join", "no joined(host)");
  }

  // 3. host sets a state (becomes lastState)
  host.send({ v: V, type: "sync", event: "play", playing: true, currentTime: 120, playbackRate: 1, seq: 1 });
  await sleep(300);

  // 4. late participant joins → must receive lastState (currentTime 120)
  const part = await open(`${SERVER_URL}/r/${roomId}`);
  part.send({ v: V, type: "join", roomId, role: "participant", name: "smoke-part" });
  try {
    await part.waitFor((m) => m.type === "joined");
    ok("participant joined");
  } catch {
    bad("participant join", "no joined");
  }
  try {
    await part.waitFor((m) => m.type === "state" && m.currentTime === 120);
    ok("participant received lastState (currentTime=120 catch-up)");
  } catch {
    bad("lastState catch-up", "no state with currentTime=120");
  }

  // 5. live relay: host seek → participant receives state 300
  host.send({ v: V, type: "sync", event: "seek", playing: true, currentTime: 300, playbackRate: 1, seq: 2 });
  try {
    await part.waitFor((m) => m.type === "state" && m.currentTime === 300);
    ok("live relay: participant received host seek (currentTime=300)");
  } catch {
    bad("live relay", "participant did not receive seek state");
  }

  // 6. ping/pong (RTT path)
  host.send({ v: V, type: "ping", id: 4242 });
  try {
    await host.waitFor((m) => m.type === "pong" && m.id === 4242);
    ok("ping → pong (id echoed)");
  } catch {
    bad("ping/pong", "no pong id=4242");
  }

  // 7. host disconnect → participant gets host_disconnected
  host.ws.close(1000, "smoke-disconnect");
  try {
    await part.waitFor((m) => m.type === "host_disconnected");
    ok("participant notified host_disconnected");
  } catch {
    bad("host_disconnected", "participant not notified");
  }

  // 8. host reconnect with token → reclaims host, participant gets host_resumed
  const host2 = await open(`${SERVER_URL}/r/${roomId}`);
  host2.send({ v: V, type: "join", roomId, role: "host", hostToken, name: "smoke-host" });
  try {
    await host2.waitFor((m) => m.type === "joined" && m.role === "host");
    ok("host reconnected and reclaimed host slot (token)");
  } catch {
    bad("host reconnect", "did not reclaim host");
  }
  try {
    await part.waitFor((m) => m.type === "host_resumed");
    ok("participant notified host_resumed");
  } catch {
    bad("host_resumed", "participant not notified");
  }

  part.ws.close();
  host2.ws.close();
}

main()
  .catch((e) => {
    bad("fatal", e.message);
  })
  .finally(() => {
    console.log(`\n──────── ${pass} passed, ${fail} failed ────────\n`);
    process.exit(fail === 0 ? 0 : 1);
  });
