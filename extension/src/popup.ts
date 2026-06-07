import type { RosterEntry } from "../../shared/protocol";
import {
  type ConnState,
  formatRosterLine,
  nextStateForServerEvent,
  renderStatusLabel,
  rosterHeader,
} from "./popup-status";

// biome-ignore lint/style/noNonNullAssertion: popup HTML elements are always present
const $ = (id: string) => document.getElementById(id)!;
const setStatus = (s: ConnState) => {
  $("status").textContent = renderStatusLabel(s);
};

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

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // biome-ignore lint/style/noNonNullAssertion: tab.id is always set for active tabs
  return tab.id!;
}

function nameValue(): string {
  return ($("name") as HTMLInputElement).value.trim();
}

$("create").addEventListener("click", async () => {
  const name = nameValue();
  await chrome.storage.local.set({ name });
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "host", name });
});

$("join").addEventListener("click", async () => {
  const roomId = ($("room") as HTMLInputElement).value.trim();
  if (!roomId) return;
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

// popup は開くたびに作り直されるため、開いた瞬間に現在状態を復元する。
(async () => {
  const { name } = await chrome.storage.local.get("name");
  if (typeof name === "string") ($("name") as HTMLInputElement).value = name;
  try {
    const resp = await chrome.tabs.sendMessage(await activeTabId(), { type: "get_status" });
    if (resp?.roomId) $("roomId").textContent = `ルームID: ${resp.roomId}（共有してください）`;
    if (resp?.status) setStatus(resp.status);
    if (resp?.roster) renderRoster(resp.roster, resp.selfId ?? null);
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
  if (msg?.type === "roster") {
    renderRoster(msg.participants, msg.selfId ?? null);
    return;
  }
  if (msg?.type !== "server_event") return;
  const next = nextStateForServerEvent(msg.event);
  if (next) setStatus(next);
});
