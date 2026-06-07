import type { RosterEntry, ServerMessage, SyncEvent } from "../../shared/protocol";
import { DEFAULTS } from "../../shared/sync-core";
import { CONNECT_SECRET, SERVER_URL } from "./config";
import { type ConnState, nextStateForServerEvent } from "./popup-status";
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

function waitForVideo(): Promise<HTMLVideoElement> {
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

async function start(session: Session): Promise<void> {
  if (started) return;
  started = true;

  const video = await waitForVideo();
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
        // biome-ignore lint/suspicious/noExplicitAny: bridging browser WebSocket handler types
        raw.onopen = fn as any;
      },
      set onclose(fn: (() => void) | null) {
        // biome-ignore lint/suspicious/noExplicitAny: bridging browser WebSocket handler types
        raw.onclose = fn as any;
      },
      set onmessage(fn: ((data: string) => void) | null) {
        raw.onmessage = fn ? (ev: MessageEvent) => fn(String(ev.data)) : null;
      },
    } as unknown as import("./ws-client").SocketLike;
  }

  let orchestrator: SyncOrchestrator;
  const client = new WsClient(SERVER_URL, {
    factory: () => makeBrowserSocket(SERVER_URL),
    onMessage: (msg: ServerMessage) => handleServer(msg),
  });

  function handleServer(msg: ServerMessage) {
    switch (msg.type) {
      case "created":
        // hostトークンを保持してhostでjoin。roomIDをpopupへ渡して表示させる。
        session.hostToken = msg.hostToken;
        session.roomId = msg.roomId;
        currentStatus = "connected";
        currentRoomId = msg.roomId;
        chrome.runtime.sendMessage({ type: "room_created", roomId: msg.roomId }).catch(() => {});
        client.send({
          v: 1,
          type: "join",
          roomId: msg.roomId,
          role: "host",
          hostToken: msg.hostToken,
          name: session.name,
        });
        break;
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
    client.send({ v: 1, type: "title", title: t });
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
    new MutationObserver(scheduleTitleSend).observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  orchestrator = new SyncOrchestrator({
    role: session.role,
    controller,
    client,
    now: () => performance.now(),
  });

  client.onOpen = () => {
    if (session.role === "host" && !session.hostToken) {
      client.send({ v: 1, type: "create" });
    } else {
      client.send({
        v: 1,
        type: "join",
        roomId: session.roomId,
        role: session.role,
        hostToken: session.hostToken,
        name: session.name,
      });
    }
  };
  client.connect();
  // 定期ping（RTT測定）— 接続ごとではなく一度だけ。WsClient.sendは未接続時no-op。
  setInterval(() => client.sendPing(), DEFAULTS.pingIntervalMs);

  // ホスト：mediaイベント送出＋heartbeat。timeupdate駆動を主にし、setIntervalを従に。
  if (session.role === "host") {
    const eventMap: Record<string, SyncEvent> = { seeked: "seek" };
    for (const dom of ["play", "pause", "seeked", "ratechange"]) {
      video.addEventListener(dom, () =>
        orchestrator.onMediaEvent(eventMap[dom] ?? (dom as SyncEvent)),
      );
    }
    let lastBeat = 0;
    const beat = () => {
      const t = performance.now();
      if (t - lastBeat >= DEFAULTS.heartbeatMs) {
        lastBeat = t;
        orchestrator.heartbeat();
      }
    };
    video.addEventListener("timeupdate", beat); // 前面では主にこちら
    setInterval(beat, DEFAULTS.heartbeatMs); // バックグラウンドのスロットリング時の従
  } else {
    // 参加者：定期tickでドリフト補正＋自分の誤操作を即リコンサイル。
    setInterval(() => void orchestrator.tick(), DEFAULTS.heartbeatMs);
    for (const dom of ["seeking", "play", "pause"]) {
      video.addEventListener(dom, () => {
        if (!controller.isApplying()) void orchestrator.tick();
      });
    }
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
