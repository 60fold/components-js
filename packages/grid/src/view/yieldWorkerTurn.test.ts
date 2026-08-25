import { afterEach, describe, expect, it, vi } from "vitest";
import { yieldWorkerTurn } from "./yieldWorkerTurn";

class TestMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly close = vi.fn();
  readonly postMessage = vi.fn();
}

class TestMessageChannel {
  static readonly instances: TestMessageChannel[] = [];

  readonly port1 = new TestMessagePort();
  readonly port2 = new TestMessagePort();

  constructor() {
    TestMessageChannel.instances.push(this);
  }
}

describe("yieldWorkerTurn", () => {
  afterEach(() => {
    TestMessageChannel.instances.length = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts synchronously and closes both one-shot ports before resolving", async () => {
    vi.stubGlobal("MessageChannel", TestMessageChannel);
    let resolved = false;

    const yielded = yieldWorkerTurn().then(() => {
      resolved = true;
    });

    const channel = TestMessageChannel.instances[0]!;
    expect(TestMessageChannel.instances).toHaveLength(1);
    expect(channel.port2.postMessage).toHaveBeenCalledOnce();
    expect(channel.port2.postMessage).toHaveBeenCalledWith(undefined);
    expect(resolved).toBe(false);

    channel.port1.onmessage?.({} as MessageEvent);
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(channel.port2.close).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    await yielded;
    expect(resolved).toBe(true);
  });

  it("falls back to a post-chunk zero-delay timer when MessageChannel is unavailable", async () => {
    vi.stubGlobal("MessageChannel", undefined);
    vi.useFakeTimers();
    let resolved = false;

    const yielded = yieldWorkerTurn().then(() => {
      resolved = true;
    });

    expect(vi.getTimerCount()).toBe(1);
    expect(resolved).toBe(false);
    await vi.runAllTimersAsync();
    await yielded;
    expect(resolved).toBe(true);
  });
});
