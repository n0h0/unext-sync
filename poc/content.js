// Phase 0 PoC v3: U-NEXTプレイヤーの<video>に到達し、"再生中に" 制御できるか検証する。
// content scriptは隔離ワールドのためConsoleからの関数呼び出しは不可。
// → 再生が10秒を超えたら自動で1回だけ制御テストを実行し、結果をconsoleに出す（実行後は元に戻す）。
// 使い方: 拡張を再読込 → タイトルを再生 → 10秒少々待つだけ。手動操作不要。
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

  // 各テストを順番に分離して実行（同時実行による干渉を防ぐ）。
  function runControlTest(v) {
    // Phase A (t=0): RATE test（再生中に単独で測定）
    const r0 = v.playbackRate;
    const r1 = r0 === 1 ? 1.5 : 1;
    v.playbackRate = r1;
    console.log(TAG, "RATE set", { from: r0, to: r1, paused: v.paused });
    setTimeout(function () {
      console.log(TAG, "RATE after 1s", {
        set: r1, now: v.playbackRate, paused: v.paused, ok: v.playbackRate === r1,
      });
      v.playbackRate = r0; // 戻す
    }, 1000);

    // Phase B (t=2s): SEEK test
    setTimeout(function () {
      const before = v.currentTime;
      const target = Math.max(0, before - 5);
      v.currentTime = target;
      console.log(TAG, "SEEK set", { before: +before.toFixed(2), target: +target.toFixed(2) });
      setTimeout(function () {
        console.log(TAG, "SEEK after 1s", {
          now: +v.currentTime.toFixed(2),
          expected_near: +target.toFixed(2),
          verdict: Math.abs(v.currentTime - target) > 3 ? "REVERTED?" : "OK",
        });
      }, 1000);
    }, 2000);

    // Phase C (t=4s): PAUSE / PLAY test
    setTimeout(function () {
      const wasPaused = v.paused;
      if (wasPaused) {
        Promise.resolve(v.play()).catch(function (e) { console.log(TAG, "play() err", e); });
      } else {
        v.pause();
      }
      setTimeout(function () {
        console.log(TAG, "PAUSE/PLAY after 1s", {
          wasPaused: wasPaused, nowPaused: v.paused, toggled: v.paused !== wasPaused,
        });
        if (wasPaused && !v.paused) v.pause();
        if (!wasPaused && v.paused) Promise.resolve(v.play()).catch(function () {});
      }, 1000);
    }, 4000);
  }

  let tested = false;
  setInterval(function () {
    const v = ensureVideo();
    if (!v) { console.log(TAG, frame, "no video yet"); return; }
    console.log(TAG, frame, "tick", {
      currentTime: +v.currentTime.toFixed(2),
      duration: v.duration,
      paused: v.paused,
      rate: v.playbackRate,
    });
    if (!tested && v.currentTime > 10 && isFinite(v.duration)) {
      tested = true;
      console.log(TAG, frame, "=== auto control test start ===");
      runControlTest(v);
    }
  }, 3000);

  console.log(TAG, frame, "PoC v4 loaded. タイトルを再生し10秒少々待つと自動でテストします（手動操作不要）。");
})();
