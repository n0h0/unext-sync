import { type ConnState, nextStateForServerEvent, renderStatusLabel } from "./popup-status";

// biome-ignore lint/style/noNonNullAssertion: popup HTML elements are always present
const $ = (id: string) => document.getElementById(id)!;
const setStatus = (s: ConnState) => {
  $("status").textContent = renderStatusLabel(s);
};

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // biome-ignore lint/style/noNonNullAssertion: tab.id is always set for active tabs
  return tab.id!;
}

$("create").addEventListener("click", async () => {
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "host" });
});

$("join").addEventListener("click", async () => {
  const roomId = ($("room") as HTMLInputElement).value.trim();
  if (!roomId) return;
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), {
    type: "start_session",
    role: "participant",
    roomId,
  });
});

// popup は開くたびに作り直されるため、開いた瞬間に content script へ現在状態を問い合わせて復元する。
(async () => {
  try {
    const resp = await chrome.tabs.sendMessage(await activeTabId(), { type: "get_status" });
    if (resp?.roomId) $("roomId").textContent = `ルームID: ${resp.roomId}（共有してください）`;
    if (resp?.status) setStatus(resp.status);
  } catch {
    // content script 未注入（U-NEXTページでない等）→ 既定の「未接続」のまま
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "room_created") {
    $("roomId").textContent = `ルームID: ${msg.roomId}（共有してください）`;
    setStatus("connected");
    return;
  }
  if (msg?.type !== "server_event") return;
  const next = nextStateForServerEvent(msg.event);
  if (next) setStatus(next);
});
