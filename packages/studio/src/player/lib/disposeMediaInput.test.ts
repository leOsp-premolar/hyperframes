import { describe, expect, it, vi } from "vitest";
import { disposeMediaInput } from "./disposeMediaInput";

describe("disposeMediaInput", () => {
  it("disposes an input that opened", async () => {
    const dispose = vi.fn();
    disposeMediaInput({ getFormat: () => Promise.resolve("mp4"), dispose });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("leaves an input whose open failed, without an unhandled rejection", async () => {
    const dispose = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    disposeMediaInput({ getFormat: () => Promise.reject(new Error("unreadable")), dispose });
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);
    expect(dispose).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
