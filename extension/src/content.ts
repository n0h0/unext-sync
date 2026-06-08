import {
  PROTOCOL_VERSION,
  type RosterEntry,
  type ServerMessage,
  type SyncEvent,
} from "../../shared/protocol";
import { DEFAULTS } from "../../shared/sync-core";
import { CONNECT_SECRET, httpBaseFrom, SERVER_URL } from "./config";
import { deriveContentKey } from "./content-key";
import { type ConnState, nextStateForServerEvent } from "./popup-status";
import { makeSessionGate } from "./session-gate";
import { SyncOrchestrator } from "./sync-orchestrator";
import { cleanTitle } from "./title";
import { VideoController } from "./video-controller";
import { WsClient } from "./ws-client";

// Shadow DOM/通常DOMを再帰探索（PoCの到達方法に合わせる）。
function deepFindVideo(root: Document | ShadowRoot): HTMLVideoElement | null {
  const direct = root.querySelector("video");
  if (direct) return direct;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) {
      const found = deepFindVideo(sr);
      if (found) return found;
    }
  }
  return null;
}

function waitForVideo(onCleanup?: (dispose: () => void) => void): Promise<HTMLVideoElement> {
  return new Promise((resolve) => {
    const found = deepFindVideo(document);
    if (found) return resolve(found);
    const mo = new MutationObserver(() => {
      const v = deepFindVideo(document);
      if (v) {
        mo.disconnect();
        resolve(v);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // video 発見まで disconnect されないため、セッション破棄時に取り残さないよう解放処理を渡す。
    // 退出で disconnect された場合この Promise は未解決のまま放置されるが、呼び出し側は await 直後の
    // life.aborted() 早期 return で抜けるため問題ない（gate.end() が副作用を解放済み）。
    onCleanup?.(() => mo.disconnect());
  });
}

interface Session {
  roomId: string;
  role: "host" | "participant";
  hostToken?: string;
  name?: string;
}
let started = false;
// popup は開くたびに破棄される一時コンテキストなので、接続状態の source of truth は
// タブと共に生き続けるこの content script が持つ。popup は開いた瞬間に get_status で問い合わせる。
let currentStatus: ConnState = "idle";
let currentRoomId: string | null = null;
let currentRoster: RosterEntry[] = [];
let currentSelfId: string | null = null;
let currentTitle: string | null = null;

const gate = makeSessionGate();

async function start(session: Session): Promise<void> {
  if (started) return;
  started = true;
  const life = gate.begin();

  const video = await waitForVideo((d) => life.add(d));
  if (life.aborted()) {
    life.dispose();
    return;
  }
  const controller = new VideoController(video);

  // ブラウザWebSocketをSocketLike（onmessageは文字列）に適合させるアダプタ。
  function makeBrowserSocket(url: string) {
    const raw = new WebSocket(url, [CONNECT_SECRET]);
    return {
      get readyState() {
        return raw.readyState;
      },
      send: (d: string) => raw.send(d),
      close: () => raw.close(),
      set onopen(fn: (() => void) | null) {
        raw.onopen = fn ? () => fn() : null;
      },
      set onclose(fn: (() => void) | null) {
        raw.onclose = fn ? () => fn() : null;
      },
      set onmessage(fn: ((data: string) => void) | null) {
        raw.onmessage = fn ? (ev: MessageEvent) => fn(String(ev.data)) : null;
      },
    } as unknown as import("./ws-client").SocketLike;
  }

  let orchestrator: SyncOrchestrator;
  const roomUrl = () => `${SERVER_URL}/r/${session.roomId}`;
  const client = new WsClient(roomUrl(), {
    factory: () => makeBrowserSocket(roomUrl()),
    onMessage: (msg: ServerMessage) => handleServer(msg),
  });
  life.add(() => client.close());

  function handleServer(msg: ServerMessage) {
    // 退出後（close() 後）に遅延到達したメッセージで idle 状態を汚さず、解放済みセッションへ
    // 副作用（title observer 等）を再登録してリークさせないためのガード。
    if (life.aborted()) return;
    switch (msg.type) {
      case "state":
        void orchestrator.onServerState(msg);
        break;
      case "joined": {
        currentSelfId = msg.clientId;
        const next = nextStateForServerEvent("joined");
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: "joined" }).catch(() => {});
        if (msg.role === "host") startHostTitleSync();
        break;
      }
      case "host_taken": {
        currentSelfId = msg.clientId;
        const next = nextStateForServerEvent("host_taken");
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: "host_taken" }).catch(() => {});
        break;
      }
      case "roster":
        currentRoster = msg.participants;
        chrome.runtime
          .sendMessage({ type: "roster", participants: msg.participants, selfId: currentSelfId })
          .catch(() => {});
        break;
      case "room_title":
        currentTitle = msg.title;
        chrome.runtime.sendMessage({ type: "room_title", title: msg.title }).catch(() => {});
        break;
      // host_disconnected / host_resumed / no_room はpopupへ転送（status更新）
      default: {
        const next = nextStateForServerEvent(msg.type);
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: msg.type }).catch(() => {});
      }
    }
  }

  // ホストのみ：document.title を浄化して送る。空なら送らず直前値を維持。
  let lastSentTitle: string | null = null;
  let titleDebounce: ReturnType<typeof setTimeout> | undefined;
  let titleObserverInstalled = false;
  function sendTitleIfChanged() {
    const t = cleanTitle(document.title);
    if (!t || t === lastSentTitle) return;
    lastSentTitle = t;
    client.send({ v: PROTOCOL_VERSION, type: "title", title: t });
  }
  function scheduleTitleSend() {
    if (titleDebounce) clearTimeout(titleDebounce);
    titleDebounce = setTimeout(sendTitleIfChanged, 1000);
  }
  function startHostTitleSync() {
    lastSentTitle = null; // (再)join のたびに現在値を確実に1回送る（サーバーが同値を弾く）
    sendTitleIfChanged();
    if (titleObserverInstalled) return;
    titleObserverInstalled = true;
    // <title> の差し替え・テキスト変更の両方を拾うため head を subtree 監視する。
    const titleObs = new MutationObserver(scheduleTitleSend);
    titleObs.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    life.add(() => titleObs.disconnect());
    life.add(() => {
      if (titleDebounce) clearTimeout(titleDebounce);
    });
  }

  orchestrator = new SyncOrchestrator({
    role: session.role,
    controller,
    client,
    now: () => performance.now(),
    localContentKey: () => deriveContentKey(location.pathname),
  });

  client.onOpen = () => {
    client.send({
      v: PROTOCOL_VERSION,
      type: "join",
      roomId: session.roomId,
      role: session.role,
      hostToken: session.hostToken,
      name: session.name,
    });
  };
  // ホスト（トークン未保持）はまず HTTP でルームを発行してから WS 接続する。
  if (session.role === "host" && !session.hostToken) {
    try {
      const res = await fetch(`${httpBaseFrom(SERVER_URL)}/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CONNECT_SECRET}` },
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      const data = (await res.json()) as { roomId: string; hostToken: string };
      if (life.aborted()) {
        life.dispose();
        return;
      }
      session.roomId = data.roomId;
      session.hostToken = data.hostToken;
      currentRoomId = data.roomId;
      chrome.runtime.sendMessage({ type: "room_created", roomId: data.roomId }).catch(() => {});
    } catch {
      life.dispose();
      currentStatus = "disconnected";
      chrome.runtime
        .sendMessage({ type: "server_event", event: "host_disconnected" })
        .catch(() => {});
      started = false; // 作成失敗時はセッションを開始済みにせず、popup から再試行できるようにする
      return;
    }
  }
  client.connect();
  // 定期ping（RTT測定）— 接続ごとではなく一度だけ。WsClient.sendは未接続時no-op。
  const pingTimer = setInterval(() => client.sendPing(), DEFAULTS.pingIntervalMs);
  life.add(() => clearInterval(pingTimer));

  // ---- SPA 話数遷移に追従するための <video> 再バインド機構 ----
  // 起動時の要素を握りっぱなしにせず、遷移で差し替わったら付け替える。
  let currentVideo = video;
  let lastPathname = location.pathname;

  // 要素非依存の安定リスナー束（再バインドで付け外しするため参照を保持する）。role ごとに構築する。
  const mediaListeners: Array<[string, () => void]> = [];
  const bindListeners = (el: HTMLVideoElement) => {
    for (const [type, fn] of mediaListeners) el.addEventListener(type, fn);
  };
  const unbindListeners = (el: HTMLVideoElement) => {
    for (const [type, fn] of mediaListeners) el.removeEventListener(type, fn);
  };

  // 遷移検知は1箇所に集約。各 tick から呼ぶ。
  // 注: waitForVideo はタイムアウトを持たない（新 <video> が現れるまで待つ）。新要素が
  // 永遠に現れない異常時は navigating が立ったままになるが、これは起動時の waitForVideo と
  // 同じ前提で、通常の SPA 遷移では新要素は速やかに出現する（MVP 許容・spec §9 で実機確認）。
  let navigating = false;
  const maybeHandleNavigation = async () => {
    if (navigating || location.pathname === lastPathname) return;
    navigating = true;
    lastPathname = location.pathname;
    try {
      // 同一要素の src 差し替えなら即座に取得、要素ごと差し替えなら新要素の出現を待つ。
      const next = await waitForVideo((d) => life.add(d));
      if (life.aborted()) return;
      if (next !== currentVideo) {
        unbindListeners(currentVideo);
        controller.setMedia(next);
        bindListeners(next);
        currentVideo = next;
      }
      // 新 contentKey＋新 currentTime で即時通知し、ズレ窓を最小化する（host のみ）。
      if (session.role === "host") orchestrator.heartbeat();
    } finally {
      navigating = false;
    }
  };

  if (session.role === "host") {
    // ホスト：mediaイベント送出＋heartbeat。timeupdate 駆動を主、setInterval を従に
    // （バックグラウンドのタイマースロットリング対策）。
    const eventMap: Record<string, SyncEvent> = { seeked: "seek" };
    for (const dom of ["play", "pause", "seeked", "ratechange"]) {
      mediaListeners.push([
        dom,
        () => orchestrator.onMediaEvent(eventMap[dom] ?? (dom as SyncEvent)),
      ]);
    }
    let lastBeat = 0;
    const beat = () => {
      const t = performance.now();
      if (t - lastBeat >= DEFAULTS.heartbeatMs) {
        lastBeat = t;
        orchestrator.heartbeat();
      }
    };
    mediaListeners.push(["timeupdate", beat]);
    bindListeners(currentVideo);
    life.add(() => unbindListeners(currentVideo));
    const hostTick = setInterval(() => {
      beat();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
    life.add(() => clearInterval(hostTick));
  } else {
    // 参加者：定期tickでドリフト補正＋自分の誤操作を即リコンサイル。
    for (const dom of ["seeking", "play", "pause"]) {
      mediaListeners.push([
        dom,
        () => {
          if (!controller.isApplying()) void orchestrator.tick();
        },
      ]);
    }
    bindListeners(currentVideo);
    life.add(() => unbindListeners(currentVideo));
    const participantTick = setInterval(() => {
      void orchestrator.tick();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
    life.add(() => clearInterval(participantTick));
  }
}

// popupからの開始指示／状態問い合わせを受ける
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "start_session") {
    if (started) return; // 既存セッション中は重複指示を無視（currentStatus を汚さない）
    currentStatus = "connecting";
    void start({ roomId: msg.roomId, role: msg.role, name: msg.name });
    return;
  }
  if (msg?.type === "leave_session") {
    gate.end(); // in-flight な start() を abort＋登録済み副作用を一括解放
    started = false;
    currentStatus = "idle";
    currentRoomId = null;
    currentRoster = [];
    currentSelfId = null;
    currentTitle = null;
    return;
  }
  if (msg?.type === "get_status") {
    sendResponse({
      status: currentStatus,
      roomId: currentRoomId,
      roster: currentRoster,
      selfId: currentSelfId,
      title: currentTitle,
    });
  }
});
