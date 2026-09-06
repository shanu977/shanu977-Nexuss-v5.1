import { useCallback, useEffect, useRef, useState } from "react";

export interface UseScreenShare {
  /** Whether a live screen share is currently active. */
  isActive: boolean;
  /** True while the native screen/window selector is open. */
  isStarting: boolean;
  /**
   * Whether the current browser/device can actually capture the screen (the
   * native getDisplayMedia API exists, which browsers only expose in secure
   * contexts). On browsers/devices without it (e.g. iOS Safari) we never fake
   * support — the UI surfaces a clear explanation instead.
   */
  supported: boolean;
  /** User-friendly error message (cancelled, denied, unsupported, ...). */
  error: string | null;
  clearError: () => void;
  /** Label of the currently selected source (from the stream track). */
  selectedSourceName: string | null;
  /** Whether the details section is expanded. */
  isExpanded: boolean;
  setExpanded: (value: boolean) => void;
  /**
   * Callback ref attached to the <video> element rendering the live preview.
   * Fires whenever the element mounts/unmounts so the still-live MediaStream is
   * reattached after the preview is hidden and shown again.
   */
  videoRef: (node: HTMLVideoElement | null) => void;
  startSharing: () => Promise<boolean>;
  stopSharing: () => void;
  changeScreen: () => Promise<void>;
  /** Capture exactly one current frame from the live preview. */
  captureFrame: () => string | null;
}

const MAX_FRAME_DIMENSION = 1280;

/**
 * Live screen sharing for the chatboard.
 *
 * The MediaStream stays in the browser and only feeds a local <video> preview.
 * No frames are sent anywhere automatically: `captureFrame` is invoked exactly
 * once per user question by the chat send path. Every track is stopped on
 * cleanup, on external termination (browser/OS controls), and on unmount.
 */
export function useScreenShare(): UseScreenShare {
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSourceName, setSelectedSourceName] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  // Computed once. `getDisplayMedia` is only ever exposed in secure contexts,
  // so its mere presence is the honest capability signal: browsers/devices
  // without it (e.g. iOS Safari) cannot capture the screen, and we never fake
  // support.
  const [supported] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getDisplayMedia
  );

  const clearError = useCallback(() => setError(null), []);

  // Attach the persistent MediaStream to whatever <video> element is current.
  // The stream is the source of truth; the element is only a visual consumer.
  // Idempotent, so it is safe to run on every mount/re-render path.
  const attachStream = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    const stream = streamRef.current;
    if (!stream) return;
    video.srcObject = stream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    void video.play().catch(() => {});
  }, []);

  // Callback ref: connect the stream whenever the preview element mounts, and
  // clear the internal pointer when it unmounts (e.g. details collapsed). The
  // stream itself is never touched here, so collapse/expand is a pure UI action.
  const videoRef = useCallback(
    (video: HTMLVideoElement | null) => {
      videoElementRef.current = video;
      attachStream(video);
    },
    [attachStream]
  );

  const cleanupStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    const video = videoElementRef.current;
    if (video) {
      video.srcObject = null;
    }
    setIsActive(false);
    setSelectedSourceName(null);
  }, []);

  // Connect the active stream to the preview <video> element. Runs when the
  // stream is adopted/replaced while the element is already mounted (the
  // callback ref above already covers the element-mount case).
  useEffect(() => {
    attachStream(videoElementRef.current);
  }, [isActive, attachStream]);

  // Detect external termination (browser/OS "Stop sharing" controls). When the
  // video track ends, release the stream and reset state without touching the
  // chat session, so the user can start sharing again.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const tracks = stream.getVideoTracks();
    const handleEnded = () => cleanupStream();
    tracks.forEach((track) => track.addEventListener("ended", handleEnded));
    return () => {
      tracks.forEach((track) => track.removeEventListener("ended", handleEnded));
    };
  }, [isActive, cleanupStream]);

  const stopSharing = useCallback(() => {
    cleanupStream();
  }, [cleanupStream]);

  // Restore Nexuss as the active UI after the native picker resolves. The
  // browser/OS may briefly activate the selected source (tab/window/screen).
  // This is a browser/platform behavior outside JS control; we can only make
  // a best-effort request to re-focus our window. The stream itself is never
  // affected — capture continues in the background regardless of focus.
  const restoreNexussFocus = useCallback(() => {
    // Best-effort synchronous focus restore. Browsers may have moved
    // activation to the picked tab/window during the native picker — this
    // is platform behavior, not Nexuss code. window.focus() is the only
    // spec-compliant way to request focus back; it never navigates and never
    // touches the MediaStream. If the platform denies it (no transient
    // activation), the stream still continues in the background.
    if (typeof window !== "undefined" && typeof window.focus === "function") {
      try {
        window.focus();
      } catch {
        // Ignore — focus may be denied without transient activation.
      }
    }
    // Ensure the document regains hasFocus where possible; jsdom returns
    // false until focused, real browsers return true after window.focus().
    if (typeof document !== "undefined" && document.hasFocus?.() === false) {
      try {
        // No navigation: just nudge focus to body if nothing else is focused
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body) {
          (document.body as HTMLElement).focus?.();
        }
      } catch {}
    }
  }, []);

  // Open the browser's native screen/window/tab selector. We never build our
  // own fake list of windows: the OS/browser controls source selection.
  const openPicker = useCallback(async (): Promise<MediaStream | null> => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getDisplayMedia
    ) {
      setError(
        "Screen sharing is not supported by this browser/device. Please use a supported desktop browser for screen sharing."
      );
      return null;
    }
    try {
      // Use the smallest safe modern option set. `video:true` is the only
      // required constraint; the remaining hints are optional best-effort
      // flags supported by Chrome/Edge (ignored by Firefox/Safari):
      // - preferCurrentTab:false keeps the chooser unbiased (user may pick any
      //   tab/window/screen, including the current tab).
      // - selfBrowserSurface:"include" allows capturing the current tab if the
      //   user wants it, without forcing it.
      // - surfaceSwitching:"include" lets the user switch sources via the
      //   browser's "Share this tab instead" button without a new prompt.
      // - systemAudio:"exclude" and monitorTypeSurfaces:"include" preserve the
      //   existing audio/screen defaults.
      // None of these trigger navigation — the track label is surfaced only as
      // UI text and is never used as a navigation target.
      return await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
        // Modern Chrome options (cast to any for cross-browser TS compat)
        ...({
          preferCurrentTab: false,
          selfBrowserSurface: "include",
          systemAudio: "exclude",
          surfaceSwitching: "include",
          monitorTypeSurfaces: "include"
        } as unknown as MediaStreamConstraints)
      } as MediaStreamConstraints);
    } catch {
      // The user cancelled the picker or the browser/OS denied permission.
      // This is an expected outcome, not an app error: stay quiet so no
      // scary message appears and sharing simply remains off.
      return null;
    }
  }, []);

  const adoptStream = useCallback(
    (stream: MediaStream) => {
      cleanupStream();
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      setSelectedSourceName(track?.label ?? null);
      setIsActive(true);
      setIsExpanded(true);
      clearError();
      // Best-effort: bring Nexuss back to foreground after selection.
      // Capture continues in background; this never touches the stream.
      restoreNexussFocus();
    },
    [cleanupStream, clearError, restoreNexussFocus]
  );

  const startSharing = useCallback(async (): Promise<boolean> => {
    setIsStarting(true);
    setError(null);
    try {
      const stream = await openPicker();
      if (!stream) return false;
      adoptStream(stream);
      return true;
    } finally {
      setIsStarting(false);
      // If picker was cancelled or denied we still ensure Nexuss retains focus
      // (adoptStream already restores on success; this covers the no-stream
      // path and any browser that moved focus during the picker).
      restoreNexussFocus();
    }
  }, [openPicker, adoptStream, restoreNexussFocus]);

  const changeScreen = useCallback(async () => {
    cleanupStream();
    await startSharing();
    restoreNexussFocus();
  }, [cleanupStream, startSharing, restoreNexussFocus]);

  // Capture ONE current frame from the live preview. Downscaled JPEG keeps the
  // payload small; the frame is transient and never stored. Each call reads the
  // live video at that moment and builds a fresh temporary canvas, so it is a
  // fully reusable operation that never consumes the stream, video, or ref.
  const captureFrame = useCallback((): string | null => {
    const video = videoElementRef.current;
    if (!video || !streamRef.current) return null;
    if (
      video.videoWidth === 0 ||
      video.videoHeight === 0 ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return null;
    }

    const scale = Math.min(
      1,
      MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight)
    );
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, width, height);
    try {
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
      return null;
    }
  }, []);

  // Unmount cleanup: never leave the screen stream running in the background.
  useEffect(() => {
    return () => {
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      streamRef.current = null;
    };
  }, []);

  return {
    isActive,
    isStarting,
    supported,
    error,
    selectedSourceName,
    isExpanded,
    setExpanded: setIsExpanded,
    videoRef,
    startSharing,
    stopSharing,
    changeScreen,
    captureFrame,
    clearError
  };
}
