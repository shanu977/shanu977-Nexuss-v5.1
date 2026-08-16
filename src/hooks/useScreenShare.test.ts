import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useScreenShare } from "@/hooks/useScreenShare";

interface FakeTrack {
  label: string;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

interface FakeStream {
  getVideoTracks: () => FakeTrack[];
  getTracks: () => FakeTrack[];
}

function makeStream(label = "VS Code") {
  const listeners: Record<string, () => void> = {};
  const track: FakeTrack = {
    label,
    stop: vi.fn(),
    addEventListener: vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    }),
    removeEventListener: vi.fn((event: string) => {
      delete listeners[event];
    })
  };
  const stream: FakeStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track]
  };
  return { stream, track, listeners };
}

let getDisplayMediaMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia: vi.fn() }
  });
  getDisplayMediaMock = navigator.mediaDevices.getDisplayMedia as unknown as ReturnType<
    typeof vi.fn
  >;
});

describe("useScreenShare", () => {
  it("starts sharing and reports the selected source", async () => {
    const { stream, track } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    let started = false;
    await act(async () => {
      started = await result.current.startSharing();
    });

    expect(started).toBe(true);
    expect(result.current.isActive).toBe(true);
    expect(result.current.selectedSourceName).toBe("Chrome");
    expect(result.current.error).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("stops sharing and stops every track", async () => {
    const { stream, track } = makeStream();
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });
    expect(result.current.isActive).toBe(true);

    act(() => result.current.stopSharing());

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);
    expect(result.current.selectedSourceName).toBeNull();
  });

  it("detects external termination and cleans up", async () => {
    const { stream, track, listeners } = makeStream("Terminal");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });
    expect(result.current.isActive).toBe(true);

    act(() => {
      listeners["ended"]?.();
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);
  });

  it("handles user cancellation gracefully", async () => {
    getDisplayMediaMock.mockRejectedValue(
      new DOMException("The user closed the dialog", "NotAllowedError")
    );
    const { result } = renderHook(() => useScreenShare());

    let started = true;
    await act(async () => {
      started = await result.current.startSharing();
    });

    expect(started).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(result.current.error).toMatch(/cancelled|permitted/i);
  });

  it("errors gracefully when screen capture is unsupported", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {}
    });
    const { result } = renderHook(() => useScreenShare());

    let started = true;
    await act(async () => {
      started = await result.current.startSharing();
    });

    expect(started).toBe(false);
    expect(result.current.error).toMatch(/not supported/i);
  });

  it("changes screen by picking a new source and replacing the stream", async () => {
    const first = makeStream("VS Code");
    const second = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValueOnce(first.stream as unknown as MediaStream);
    getDisplayMediaMock.mockResolvedValueOnce(second.stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });
    expect(result.current.selectedSourceName).toBe("VS Code");

    await act(async () => {
      await result.current.changeScreen();
    });

    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(second.track.stop).not.toHaveBeenCalled();
    expect(result.current.selectedSourceName).toBe("Chrome");
    expect(result.current.isActive).toBe(true);
  });

  it("captures exactly one current frame from the live preview", async () => {
    const { stream } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });

    const fakeCtx = { drawImage: vi.fn() };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,FRAME");

    result.current.videoRef.current = {
      videoWidth: 1920,
      videoHeight: 1080,
      readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
      play: vi.fn().mockResolvedValue(undefined)
    } as unknown as HTMLVideoElement;

    const frame = result.current.captureFrame();
    const frame2 = result.current.captureFrame();

    expect(frame).toBe("data:image/jpeg;base64,FRAME");
    expect(frame2).toBe("data:image/jpeg;base64,FRAME");
    expect(fakeCtx.drawImage).toHaveBeenCalledTimes(2);

    getContextSpy.mockRestore();
    toDataURLSpy.mockRestore();
  });

  it("returns null when the video is not ready", async () => {
    const { stream } = makeStream();
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });

    expect(result.current.captureFrame()).toBeNull();

    result.current.videoRef.current = {
      videoWidth: 0,
      videoHeight: 0,
      readyState: 0
    } as unknown as HTMLVideoElement;
    expect(result.current.captureFrame()).toBeNull();
  });
});
