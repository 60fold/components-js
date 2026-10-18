/// <reference lib="webworker" />

const interval = setInterval(() => {
  self.postMessage({ sentAtEpochMs: performance.timeOrigin + performance.now() });
}, 10);

self.onmessage = (event: MessageEvent<{ readonly type: "dispose" }>) => {
  if (event.data.type !== "dispose") return;
  clearInterval(interval);
  self.close();
};
