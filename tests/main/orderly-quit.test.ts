import { EventEmitter } from "node:events";
import type { App, Event as ElectronEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installOrderlyQuitDrain } from "../../src/main/orderly-quit";

describe("orderly application quit", () => {
  it("holds quit until host-owned OAuth sessions are drained and cleaned up", async () => {
    const app = fakeApp();
    const gate = deferred<void>();
    const cleanup = vi.fn();
    const drain = vi.fn(() => gate.promise);
    installOrderlyQuitDrain(app, { drain, cleanup });

    const first = quitEvent();
    const duplicate = quitEvent();
    app.emit("before-quit", first.event);
    app.emit("before-quit", duplicate.event);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(duplicate.preventDefault).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    gate.resolve();
    await flushMicrotasks();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("leaves the app running after an unconfirmed drain and permits a later retry", async () => {
    const app = fakeApp();
    const onError = vi.fn();
    const drain = vi.fn()
      .mockRejectedValueOnce(new Error("helper still live"))
      .mockResolvedValueOnce(undefined);
    installOrderlyQuitDrain(app, { drain, onError });

    const first = quitEvent();
    app.emit("before-quit", first.event);
    await flushMicrotasks();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "helper still live" }));
    expect(app.quit).not.toHaveBeenCalled();

    const retry = quitEvent();
    app.emit("before-quit", retry.event);
    await flushMicrotasks();
    expect(retry.preventDefault).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(app.quit).toHaveBeenCalledOnce();
  });
});

function fakeApp(): Pick<App, "on" | "removeListener" | "quit"> & EventEmitter & { quit: ReturnType<typeof vi.fn> } {
  const app = new EventEmitter() as Pick<App, "on" | "removeListener" | "quit"> & EventEmitter & {
    quit: ReturnType<typeof vi.fn>;
  };
  app.quit = vi.fn<() => void>();
  return app;
}

function quitEvent(): { event: ElectronEvent; preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  return { event: { preventDefault } as unknown as ElectronEvent, preventDefault };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
