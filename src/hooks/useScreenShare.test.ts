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

function makeVideo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    srcObject: null,
    muted: false,
    autoplay: false,
    playsInline: false,
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
    play: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as HTMLVideoElement;
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

  it("never navigates, opens windows, or uses the source label as a navigation target", async () => {
    // A realistic Chrome tab label. It must be surfaced ONLY as source info and
    // must never be interpreted as a URL, route, or tab to switch to.
    const { stream, track } = makeStream("Google Chrome — ChatGPT");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const hrefBefore = window.location.href;

    const { result } = renderHook(() => useScreenShare());
    let started = false;
    await act(async () => {
      started = await result.current.startSharing();
    });

    expect(started).toBe(true);
    // The label is only surfaced as source information, never a navigation
    // target, and no navigation/window/tab APIs are invoked.
    expect(result.current.selectedSourceName).toBe("Google Chrome — ChatGPT");
    expect(openSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
    expect(track.stop).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);

    openSpy.mockRestore();
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
    expect(result.current.error).toBeNull();
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

    act(() => {
      result.current.videoRef(makeVideo());
    });

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

    act(() => {
      result.current.videoRef(makeVideo({ videoWidth: 0, videoHeight: 0, readyState: 0 }));
    });
    expect(result.current.captureFrame()).toBeNull();
  });

  it("reattaches the live stream to a newly mounted video element", async () => {
    const { stream } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });

    // A fresh <video> element appears (e.g. the preview remounts after the
    // details section is collapsed and expanded again). It must be reconnected
    // to the SAME persistent MediaStream, not a new one.
    const video = makeVideo();
    act(() => {
      result.current.videoRef(video);
    });

    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.play).toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);
  });

  it("unmounting the preview element does not stop the stream", async () => {
    const { stream, track } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });

    act(() => {
      result.current.videoRef(makeVideo());
    });
    expect(result.current.isActive).toBe(true);

    // Collapse: React unmounts the preview -> the ref callback receives null.
    // The stream must stay alive and the session must stay active.
    act(() => {
      result.current.videoRef(null);
    });

    expect(track.stop).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);

    // Expand: a new element reconnects to the same still-live stream.
    const video2 = makeVideo();
    act(() => {
      result.current.videoRef(video2);
    });
    expect(video2.srcObject).toBe(stream);
    expect(track.stop).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);
  });

  it("captures a fresh frame for every question without stopping the stream", async () => {
    const { stream, track } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);
    const { result } = renderHook(() => useScreenShare());

    await act(async () => {
      await result.current.startSharing();
    });

    const fakeCtx = { drawImage: vi.fn() };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
    const frames = ["FRAME1", "FRAME2", "FRAME3"];
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(() => `data:image/jpeg;base64,${frames.shift()}`);

    act(() => {
      result.current.videoRef(makeVideo());
    });

    // Simulates the send path: capture once per question, stream stays alive.
    const q1 = result.current.captureFrame();
    const q2 = result.current.captureFrame();
    const q3 = result.current.captureFrame();

    expect(q1).toBe("data:image/jpeg;base64,FRAME1");
    expect(q2).toBe("data:image/jpeg;base64,FRAME2");
    expect(q3).toBe("data:image/jpeg;base64,FRAME3");
    expect(fakeCtx.drawImage).toHaveBeenCalledTimes(3);
    expect(track.stop).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);

    getContextSpy.mockRestore();
    toDataURLSpy.mockRestore();
  });
});
