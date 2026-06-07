import { expect, test, vi } from "vitest";
import { type MediaLike, VideoController } from "./video-controller";

function fakeMedia(init: Partial<MediaLike> = {}): MediaLike & { _play: any; _pause: any } {
  const m: any = {
    currentTime: init.currentTime ?? 0,
    playbackRate: init.playbackRate ?? 1,
    paused: init.paused ?? true,
    play: vi.fn(() => {
      m.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      m.paused = true;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  m._play = m.play;
  m._pause = m.pause;
  return m;
}

test("readState reflects the media element", () => {
  const m = fakeMedia({ currentTime: 12.3, playbackRate: 1.5, paused: false });
  const c = new VideoController(m);
  expect(c.readState()).toEqual({ playing: true, currentTime: 12.3, playbackRate: 1.5 });
});

test("apply sets time/rate and play state", async () => {
  const m = fakeMedia({ paused: true });
  const c = new VideoController(m);
  await c.apply({ playing: true, currentTime: 100, playbackRate: 2 });
  expect(m.currentTime).toBe(100);
  expect(m.playbackRate).toBe(2);
  expect(m.play).toHaveBeenCalled();
});

test("apply pauses when playing=false", async () => {
  const m = fakeMedia({ paused: false });
  const c = new VideoController(m);
  await c.apply({ playing: false, currentTime: 100, playbackRate: 1 });
  expect(m.pause).toHaveBeenCalled();
});

test("apply does not seek when within toleranceSec", async () => {
  const m = fakeMedia({ currentTime: 100, paused: false });
  const c = new VideoController(m);
  await c.apply({ playing: true, currentTime: 100.5, playbackRate: 1 }, 1);
  expect(m.currentTime).toBe(100); // 0.5s差 < 1s → seekしない
});

test("isApplying guard is true only during apply", async () => {
  const m = fakeMedia();
  const c = new VideoController(m);
  expect(c.isApplying()).toBe(false);
  const p = c.apply({ playing: true, currentTime: 5, playbackRate: 1 });
  // applyは同期的にフラグを立てる
  expect(c.isApplying()).toBe(true);
  await p;
  expect(c.isApplying()).toBe(false);
});

test("setMedia 差し替え後は read が新 media を指す", () => {
  const m1 = fakeMedia({ currentTime: 10, paused: true });
  const m2 = fakeMedia({ currentTime: 50, paused: false });
  const c = new VideoController(m1);
  c.setMedia(m2);
  expect(c.readState()).toEqual({ playing: true, currentTime: 50, playbackRate: 1 });
});

test("setMedia 後の apply は新 media を操作し、ガード不変条件を維持", async () => {
  const m1 = fakeMedia();
  const m2 = fakeMedia({ paused: true });
  const c = new VideoController(m1);
  c.setMedia(m2);
  const p = c.apply({ playing: true, currentTime: 7, playbackRate: 1 });
  expect(c.isApplying()).toBe(true); // ガードは同期的に立つ
  await p;
  expect(m2.currentTime).toBe(7);
  expect(m2.play).toHaveBeenCalled();
  expect(m1.play).not.toHaveBeenCalled(); // 旧 media は触らない
  expect(c.isApplying()).toBe(false);
});
