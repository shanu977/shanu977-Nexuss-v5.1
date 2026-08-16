import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import ScreenSharePanel from "./ScreenSharePanel";
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
  const track: FakeTrack = {
    label,
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  const stream: FakeStream = {
    getVideoTracks: () => [track],
    getTracks: () => [track]
  };
  return { stream, track };
}

function Harness({ onFrame }: { onFrame: (frame: string | null) => void }) {
  const screenShare = useScreenShare();
  const { isActive, error } = screenShare;
  return (
    <div>
      <button type="button" onClick={() => void screenShare.startSharing()}>
        Start sharing
      </button>
      <button type="button" onClick={() => onFrame(screenShare.captureFrame())}>
        Capture frame
      </button>
      {(isActive || !!error) && <ScreenSharePanel screenShare={screenShare} />}
    </div>
  );
}

let getDisplayMediaMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia: vi.fn() }
  });
  getDisplayMediaMock = navigator.mediaDevices.getDisplayMedia as unknown as ReturnType<
    typeof vi.fn
  >;

  // jsdom has no real media pipeline. Give media elements a workable srcObject
  // setter and a play() so the hook's attachment logic can run.
  if (!("srcObject" in HTMLMediaElement.prototype)) {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      set(this: HTMLMediaElement, value: unknown) {
        Object.defineProperty(this, "_srcObject", {
          value,
          writable: true,
          configurable: true
        });
      },
      get(this: HTMLMediaElement) {
        return (this as unknown as { _srcObject?: unknown })._srcObject ?? null;
      }
    });
  }
  if (typeof HTMLMediaElement.prototype.play !== "function") {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: () => Promise.resolve()
    });
  }
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

describe("ScreenSharePanel + useScreenShare", () => {
  it("keeps the live preview mounted and attached across collapse/expand", async () => {
    const { stream, track } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);

    render(<Harness onFrame={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));

    const video = await screen.findByLabelText("Live screen share preview");
    expect(video).toBeInTheDocument();
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect((video as HTMLVideoElement).autoplay).toBe(true);
    expect((video as HTMLVideoElement).playsInline).toBe(true);
    expect((video as HTMLVideoElement).srcObject).toBe(stream);
    expect(track.stop).not.toHaveBeenCalled();
    expect(screen.getByText("Sharing")).toBeInTheDocument();

    const headerToggle = screen.getByRole("button", { name: /screen share/i });

    // Collapse: only the UI collapses; the <video> must stay mounted with the
    // stream still attached and the session still active.
    fireEvent.click(headerToggle);
    expect(screen.queryByText("Sharing")).not.toBeInTheDocument();
    expect(video.isConnected).toBe(true);
    expect((video as HTMLVideoElement).srcObject).toBe(stream);
    expect(track.stop).not.toHaveBeenCalled();

    // Expand again: same element, same stream, no re-request for permission.
    fireEvent.click(headerToggle);
    expect(screen.getByText("Sharing")).toBeInTheDocument();
    expect(video.isConnected).toBe(true);
    expect((video as HTMLVideoElement).srcObject).toBe(stream);
    expect(getDisplayMediaMock).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("captures fresh frames from the same live stream after collapse/expand", async () => {
    const { stream, track } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);

    const captured: (string | null)[] = [];
    render(<Harness onFrame={(f) => captured.push(f)} />);

    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    const video = await screen.findByLabelText("Live screen share preview");

    // Make the jsdom <video> look like a ready, dimensioned preview element.
    Object.defineProperty(video, "videoWidth", { value: 1920 });
    Object.defineProperty(video, "videoHeight", { value: 1080 });
    Object.defineProperty(video, "readyState", {
      value: HTMLMediaElement.HAVE_CURRENT_DATA
    });

    const fakeCtx = { drawImage: vi.fn() };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
    const frames = ["FRAME_A", "FRAME_B", "FRAME_C"];
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(() => `data:image/jpeg;base64,${frames.shift()}`);

    // Question 1 (expanded).
    fireEvent.click(screen.getByRole("button", { name: "Capture frame" }));
    // Collapse then expand between questions, exactly like the reported flow.
    fireEvent.click(screen.getByRole("button", { name: /screen share/i }));
    fireEvent.click(screen.getByRole("button", { name: /screen share/i }));
    // Question 2.
    fireEvent.click(screen.getByRole("button", { name: "Capture frame" }));
    // Question 3.
    fireEvent.click(screen.getByRole("button", { name: "Capture frame" }));

    expect(captured).toEqual([
      "data:image/jpeg;base64,FRAME_A",
      "data:image/jpeg;base64,FRAME_B",
      "data:image/jpeg;base64,FRAME_C"
    ]);
    expect(fakeCtx.drawImage).toHaveBeenCalledTimes(3);
    expect((video as HTMLVideoElement).srcObject).toBe(stream);
    expect(getDisplayMediaMock).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();

    getContextSpy.mockRestore();
    toDataURLSpy.mockRestore();
  });

  it("stops sharing only when explicitly requested, releasing the stream", async () => {
    const { stream, track } = makeStream("Chrome");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);

    render(<Harness onFrame={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    const video = await screen.findByLabelText("Live screen share preview");
    expect((video as HTMLVideoElement).srcObject).toBe(stream);

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect((video as HTMLVideoElement).srcObject).toBeNull();
    expect(video).not.toBeInTheDocument();
  });

  it("shows the selected source and the return-to-chat hint while sharing", async () => {
    const { stream, track } = makeStream("Google Chrome — ChatGPT");
    getDisplayMediaMock.mockResolvedValue(stream as unknown as MediaStream);

    render(<Harness onFrame={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    await screen.findByLabelText("Live screen share preview");

    // Expanded: the active source is surfaced as source information and the
    // user is guided back to the chat to ask a question.
    expect(screen.getByText("Google Chrome — ChatGPT")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The screen is being shared. Return to this chat to ask your question."
      )
    ).toBeInTheDocument();
    expect(track.stop).not.toHaveBeenCalled();

    // Collapsed: the header still shows the source so the share stays obvious.
    fireEvent.click(screen.getByRole("button", { name: /screen share/i }));
    expect(screen.getByText(/Google Chrome — ChatGPT/)).toBeInTheDocument();
    expect(screen.queryByText("Sharing")).not.toBeInTheDocument();
    expect(track.stop).not.toHaveBeenCalled();
  });
});