// Regression tests for the REAL specialFolders module (not mocked): the
// browser process polyfill reports a fake cwd of "/" and no USERPROFILE/HOME.
// getDefaultUserWorkspace() must never surface that "/" as a workspace — it
// was the root of the "\name" / "\\name" (UNC) path-collapse bug.
import { describe, it, expect, afterEach } from "vitest";
import { getDefaultUserWorkspace, resolveSpecialFolderAbsolute } from "./specialFolders";

const realCwd = process.cwd.bind(process);
const savedUserProfile = process.env.USERPROFILE;
const savedHome = process.env.HOME;

function enterWorld(userProfile: string | undefined, home: string | undefined, cwd: string) {
  if (userProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = userProfile;
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  (process as any).cwd = () => cwd;
}

afterEach(() => {
  (process as any).cwd = realCwd;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe("getDefaultUserWorkspace under the browser process polyfill", () => {
  it("never returns the webpack '/' cwd as a workspace", () => {
    enterWorld(undefined, undefined, "/");
    expect(getDefaultUserWorkspace()).toBe("");
  });

  it("never returns an empty cwd as a workspace", () => {
    enterWorld(undefined, undefined, "");
    expect(getDefaultUserWorkspace()).toBe("");
  });

  it("never returns a lone backslash cwd as a workspace", () => {
    enterWorld(undefined, undefined, "\\");
    expect(getDefaultUserWorkspace()).toBe("");
  });

  it("returns the real home when it is available", () => {
    enterWorld("C:\\Users\\someone", undefined, "/");
    expect(getDefaultUserWorkspace()).toBe("C:\\Users\\someone");
  });

  it("returns the home even when cwd equals home", () => {
    enterWorld("C:\\Users\\someone", undefined, "C:\\Users\\someone");
    expect(getDefaultUserWorkspace()).toBe("C:\\Users\\someone");
  });

  it("resolveSpecialFolderAbsolute never roots at the fake '/' cwd", () => {
    enterWorld(undefined, undefined, "/");
    expect(resolveSpecialFolderAbsolute("downloads")).toBe("Downloads");
    expect(resolveSpecialFolderAbsolute("desktop")).toBe("Desktop");
  });

  it("resolveSpecialFolderAbsolute still resolves against a real home", () => {
    enterWorld("C:\\Users\\someone", undefined, "/");
    expect(resolveSpecialFolderAbsolute("downloads")).toBe("C:\\Users\\someone\\Downloads");
  });
});
