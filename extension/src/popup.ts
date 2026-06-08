import type { RosterEntry } from "../../shared/protocol";
import {
  type ConnState,
  formatRosterLine,
  isActiveSession,
  isValidRoomId,
  leaveControlsVisible,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
  unavailableNotice,
} from "./popup-status";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};
// 表示と内部状態を一元化する。currentState は再押下ガード（isActiveSession）に使う。
let currentState: ConnState = "idle";
const setStatus = (s: ConnState) => {
  currentState = s;
  // #status はドット＋ラベルを内包するため textContent では潰さず、ラベルだけ差し替える。
  // data-state は CSS のドット配色・脈動アニメを駆動する（popup.html 参照）。
  $("status").dataset.state = s;
  $("statusLabel").textContent = renderStatusLabel(s);
  // セッションがある間（idle 以外）だけ退出 UI を出す。
  ($("leaveBlock") as HTMLElement).hidden = !leaveControlsVisible(s);
};

/** ルームID行（#roomId）を表示し、コードを等幅で描画する。生IDを textContent で安全に出す。 */
function showRoomId(id: string) {
  $("roomCode").textContent = id;
  ($("roomId") as HTMLElement).hidden = false;
}

function renderRoster(entries: RosterEntry[], selfId: string | null) {
  $("rosterHeader").textContent = entries.length ? rosterHeader(entries) : "";
  const list = $("roster");
  list.textContent = "";
  for (const e of entries) {
    const row = document.createElement("div");
    row.textContent = formatRosterLine(e, selfId);
    if (!e.connected) row.classList.add("offline");
    list.appendChild(row);
  }
}

function showWatchingTitle(title: string | null) {
  $("watchingTitle").textContent = renderWatchingTitle(title) ?? "";
}

/** content script に到達できないページ（U-NEXT再生ページ以外）で開いたときの案内＋操作無効化。 */
function showUnavailable() {
  const guard = $("guard");
  guard.textContent = unavailableNotice();
  guard.hidden = false;
  ($("create") as HTMLButtonElement).disabled = true;
  ($("join") as HTMLButtonElement).disabled = true;
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tab?.id;
  if (id === undefined) throw new Error("no active tab");
  return id;
}

function nameValue(): string {
  return ($("name") as HTMLInputElement).value.trim();
}

$("create").addEventListener("click", async () => {
  if (isActiveSession(currentState)) return; // 既存セッション中は表示を巻き戻さない
  const name = nameValue();
  await chrome.storage.local.set({ name });
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "host", name });
});

function setRoomError(msg: string | null) {
  const el = $("roomError");
  el.textContent = msg ?? "";
  (el as HTMLElement).hidden = !msg;
}

// 入力を直したらエラーを消す
($("room") as HTMLInputElement).addEventListener("input", () => setRoomError(null));

$("join").addEventListener("click", async () => {
  if (isActiveSession(currentState)) return; // 既存セッション中は表示を巻き戻さない
  const roomId = ($("room") as HTMLInputElement).value.trim();
  if (!roomId) return;
  // 不正な文字のルームIDは worker が 404 を返し WS が確立せず「接続中」で固着するため、
  // 接続を試みず即エラー表示する。
  if (!isValidRoomId(roomId)) {
    setRoomError("ルームIDは英数字のみ・1〜32文字です");
    return;
  }
  setRoomError(null);
  const name = nameValue();
  await chrome.storage.local.set({ name });
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), {
    type: "start_session",
    role: "participant",
    roomId,
    name,
  });
});

$("copyRoom").addEventListener("click", async () => {
  const code = $("roomCode").textContent;
  if (!code) return;
  await navigator.clipboard.writeText(code);
  const btn = $("copyRoom");
  const prev = btn.textContent;
  btn.textContent = "✓ コピー済み";
  setTimeout(() => {
    btn.textContent = prev;
  }, 1200);
});

function collapseLeaveConfirm() {
  ($("leave") as HTMLElement).hidden = false;
  ($("leaveConfirm") as HTMLElement).hidden = true;
}

/** 退出確定後に popup を未接続表示へ戻す。create/join フォームは常時表示なのでそのまま使える。 */
function resetToIdle() {
  setStatus("idle"); // leaveBlock もここで隠れる
  ($("roomId") as HTMLElement).hidden = true;
  $("roomCode").textContent = "";
  $("rosterHeader").textContent = "";
  $("roster").textContent = "";
  $("watchingTitle").textContent = "";
  collapseLeaveConfirm();
}

$("leave").addEventListener("click", () => {
  ($("leave") as HTMLElement).hidden = true;
  ($("leaveConfirm") as HTMLElement).hidden = false;
});

$("leaveCancel").addEventListener("click", collapseLeaveConfirm);

$("leaveYes").addEventListener("click", async () => {
  chrome.tabs.sendMessage(await activeTabId(), { type: "leave_session" });
  resetToIdle();
});

// popup は開くたびに作り直されるため、開いた瞬間に現在状態を復元する。
(async () => {
  const { name } = await chrome.storage.local.get("name");
  if (typeof name === "string") ($("name") as HTMLInputElement).value = name;
  try {
    const resp = await chrome.tabs.sendMessage(await activeTabId(), { type: "get_status" });
    if (resp?.roomId) showRoomId(resp.roomId);
    if (resp?.status) setStatus(resp.status);
    if (resp?.roster) renderRoster(resp.roster, resp.selfId ?? null);
    if (resp?.title) showWatchingTitle(resp.title);
  } catch {
    // content script 未注入（U-NEXTページでない等）→ 案内を出し作成／参加を無効化する
    showUnavailable();
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "room_created") {
    showRoomId(msg.roomId);
    setStatus("connected");
    return;
  }
  if (msg?.type === "roster") {
    renderRoster(msg.participants, msg.selfId ?? null);
    return;
  }
  if (msg?.type === "room_title") {
    showWatchingTitle(msg.title);
    return;
  }
  if (msg?.type !== "server_event") return;
  const next = nextStateForServerEvent(msg.event);
  if (next) setStatus(next);
});
