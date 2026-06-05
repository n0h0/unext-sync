// Phase 0 PoC: U-NEXTプレイヤーの<video>に到達し、読み書きできるか検証する。
// すべての結果を [WatchSync PoC] プレフィックスでconsoleに出す。
(function () {
  const TAG = "[WatchSync PoC]";
  const frame = window === window.top ? "TOP" : "IFRAME(" + location.href + ")";

  function deepFindVideo(root) {
    // 通常DOM
    const direct = root.querySelector && root.querySelector("video");
    if (direct) return { video: direct, via: "querySelector" };
    // Shadow DOMを再帰探索
    const walker = (root.querySelectorAll ? root.querySelectorAll("*") : []);
    for (const el of walker) {
      if (el.shadowRoot) {
        const found = deepFindVideo(el.shadowRoot);
        if (found) return { video: found.video, via: "shadowRoot>" + found.via };
      }
    }
    return null;
  }

  function probe() {
    const found = deepFindVideo(document);
    if (!found) {
      console.log(TAG, frame, "video NOT found yet");
      return false;
    }
    const v = found.video;
    console.log(TAG, frame, "video FOUND via", found.via, {
      readCurrentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      playbackRate: v.playbackRate,
      readonlyHint: Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(v), "currentTime"
      ),
    });
    // 制御テスト：5秒前へseekしてみる（小さく）
    try {
      const before = v.currentTime;
      v.currentTime = Math.max(0, before - 5);
      console.log(TAG, frame, "seek write attempt", { before, after: v.currentTime });
    } catch (e) {
      console.log(TAG, frame, "seek write FAILED", e);
    }
    return true;
  }

  if (!probe()) {
    const mo = new MutationObserver(() => {
      if (probe()) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 30000);
  }
})();
