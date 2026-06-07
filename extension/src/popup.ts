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
