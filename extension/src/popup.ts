import { renderStatusLabel, type ConnState } from "./popup-status";

const $ = (id: string) => document.getElementById(id)!;
const setStatus = (s: ConnState) => { $("status").textContent = renderStatusLabel(s); };

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "participant", roomId });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "room_created") {
    $("roomId").textContent = "ルームID: " + msg.roomId + "（共有してください）";
    setStatus("connected");
    return;
  }
  if (msg?.type !== "server_event") return;
  if (msg.event === "host_disconnected") setStatus("host_gone");
  else if (msg.event === "host_resumed") setStatus("connected");
  else if (msg.event === "host_taken") setStatus("connected"); // participantフォールバック
  else if (msg.event === "no_room") setStatus("no_room");
});
