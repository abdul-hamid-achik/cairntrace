import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const LISTENER_METHODS = [
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
] as const;

/**
 * Simulate a runtime that loses child exit notifications (Bun on Linux, see
 * src/core/runner/childExit.ts): `exit` listeners added to a child whose
 * command line contains `marker` are silently dropped, so nothing that
 * waits on the event ever hears it — while the process itself exits and is
 * reaped as usual. Returns the restore function.
 */
export function dropExitEvents(marker: string): () => void {
  const proto = ChildProcess.prototype as unknown as Record<string, unknown>;
  const own = new Map(
    LISTENER_METHODS.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(proto, name),
    ]),
  );
  for (const name of LISTENER_METHODS) {
    const original = (
      EventEmitter.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >
    )[name]!;
    proto[name] = function (
      this: ChildProcess,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): unknown {
      if (
        event === "exit" &&
        (this.spawnargs ?? []).some((arg) => arg.includes(marker))
      ) {
        return this;
      }
      return original.call(this, event, listener);
    };
  }
  return () => {
    for (const name of LISTENER_METHODS) {
      const descriptor = own.get(name);
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  };
}
