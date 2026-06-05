export type ConnState =
  | "idle" | "connecting" | "connected" | "disconnected" | "host_gone";

export function renderStatusLabel(s: ConnState): string {
  switch (s) {
    case "idle": return "未接続";
    case "connecting": return "接続中";
    case "connected": return "接続済み";
    case "disconnected": return "切断";
    case "host_gone": return "ホスト切断";
  }
}
