// Phase 0 PoC v2: U-NEXTプレイヤーの<video>に到達し、"再生中に" 制御できるか検証する。
// すべて [WatchSync PoC] プレフィックスでconsoleに出す。
// 使い方: 拡張を再読込 → タイトルを再生 → 15秒ほど進めてから Console で __wsTest() を実行。
(function () {
  const TAG = "[WatchSync PoC]";
  const frame = window === window.top ? "TOP" : "IFRAME";

  function deepFindVideo(root) {
    const direct = root.querySelector && root.querySelector("video");
    if (direct) return { video: direct, via: "querySelector" };
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) {
        const found = deepFindVideo(el.shadowRoot);
        if (found) return { video: found.video, via: "shadowRoot>" + found.via };
      }
    }
    return null;
  }

  let video = null;
  function ensureVideo() {
    if (video && document.contains(video)) return video;
    const found = deepFindVideo(document);
    if (found) {
      video = found.video;
      console.log(TAG, frame, "video bound via", found.via);
    } else {
      video = null;
    }
    return video;
  }

  // 1) 受動モニタ：currentTimeが増えるか / durationが実値になるかを確認
  setInterval(function () {
    const v = ensureVideo();
    if (!v) { console.log(TAG, frame, "no video yet"); return; }
    console.log(TAG, frame, "tick", {
      currentTime: Number(v.currentTime.toFixed(2)),
      duration: v.duration,
      paused: v.paused,
      rate: v.playbackRate,
    });
  }, 3000);

  // 2) 能動制御テスト：再生が進んだ後に手動で呼ぶ
  window.__wsTest = function () {
    const v = ensureVideo();
    if (!v) { console.log(TAG, "no video"); return; }
    if (!(v.currentTime > 8)) {
      console.log(TAG, "再生をもう少し進めてから(8秒以上)実行してください。now=", v.currentTime);
      return;
    }

    // --- SEEK test ---
    const before = v.currentTime;
    const target = Math.max(0, before - 5);
    v.currentTime = target;
    console.log(TAG, "SEEK set", { before, target });
    setTimeout(function () {
      console.log(TAG, "SEEK after 0.8s", {
        now: Number(v.currentTime.toFixed(2)),
        expected_near: Number(target.toFixed(2)),
        stuck_or_reverted: Math.abs(v.currentTime - target) > 3 ? "REVERTED?" : "OK",
      });
    }, 800);

    // --- PAUSE / PLAY test ---
    const wasPaused = v.paused;
    console.log(TAG, "PAUSE/PLAY test: wasPaused", wasPaused);
    if (wasPaused) {
      Promise.resolve(v.play()).catch(function (e) { console.log(TAG, "play() err", e); });
    } else {
      v.pause();
    }
    setTimeout(function () {
      console.log(TAG, "PAUSE/PLAY after 0.8s paused=", v.paused, "(toggled?", v.paused !== wasPaused, ")");
      // 元の状態に戻す
      if (wasPaused && !v.paused) v.pause();
      if (!wasPaused && v.paused) Promise.resolve(v.play()).catch(function () {});
    }, 800);

    // --- RATE test ---
    const r0 = v.playbackRate;
    const r1 = r0 === 1 ? 1.5 : 1;
    v.playbackRate = r1;
    setTimeout(function () {
      console.log(TAG, "RATE after 0.8s", { set: r1, now: v.playbackRate, ok: v.playbackRate === r1 });
      v.playbackRate = r0; // 戻す
    }, 800);
  };

  console.log(TAG, frame, "PoC v2 loaded. 再生を8秒以上進めてから Console で __wsTest() を実行してください。");
})();
