/**
 * Yields through a one-shot MessagePort task, avoiding zero-delay timer floors
 * while giving queued worker control tasks an event-loop opportunity.
 */
export function yieldWorkerTurn(): Promise<void> {
  if (typeof MessageChannel !== "function") {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}
