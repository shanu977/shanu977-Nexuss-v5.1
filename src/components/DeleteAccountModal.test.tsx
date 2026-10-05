import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import DeleteAccountModal from "@/components/DeleteAccountModal";

const mocks = vi.hoisted(() => {
  const signOut = vi.fn().mockResolvedValue(undefined);
  const state = {
    user: { uid: "uid-123" },
    signOut
  };
  return {
    state,
    signOut,
    startAccountDeletion: vi.fn(),
    getDeletionStatus: vi.fn(),
    getReauthMethod: vi.fn(),
    reauthenticateWithPassword: vi.fn(),
    reauthenticateWithGoogle: vi.fn(),
    purgeLocalAccountData: vi.fn().mockResolvedValue(undefined),
    clearAuthCache: vi.fn(),
    useAuthStore: Object.assign((selector: (s: unknown) => unknown) => selector(state), {
      getState: () => state,
      setState: () => {}
    })
  };
});

vi.mock("@/services/account", () => ({
  DELETION_STAGE_LABELS: {
    queued: "Deletion queued",
    deleting_data: "Removing your data from Nexuss servers",
    removing_auth: "Removing your Firebase sign-in account",
    verifying: "Verifying that nothing was left behind"
  },
  startAccountDeletion: mocks.startAccountDeletion,
  getDeletionStatus: mocks.getDeletionStatus,
  getReauthMethod: mocks.getReauthMethod,
  reauthenticateWithPassword: mocks.reauthenticateWithPassword,
  reauthenticateWithGoogle: mocks.reauthenticateWithGoogle
}));
vi.mock("@/services/accountData", () => ({
  purgeLocalAccountData: mocks.purgeLocalAccountData
}));
vi.mock("@/services/api", () => ({ clearAuthCache: mocks.clearAuthCache }));
vi.mock("@/store/useAuthStore", () => ({ useAuthStore: mocks.useAuthStore }));

const CONFIRM = "Type DELETE to confirm";

const NO_DELETION = {
  state: "none",
  stage: null,
  attempt: 0,
  next_attempt_at: null,
  last_error: null,
  detail: null
};

function status(patch: Record<string, unknown> = {}) {
  return { ...NO_DELETION, ...patch };
}

function getConfirmButton() {
  return screen.getByRole("button", { name: "Delete Account Permanently" });
}

/**
 * Flush the on-open status check and return the confirmation field.
 *
 * Deliberately avoids `findBy*` so the helper also works when a test has
 * installed fake timers.
 */
async function openConfirmView() {
  await act(async () => {});
  return screen.getByLabelText(CONFIRM);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getReauthMethod.mockReturnValue("popup");
  mocks.getDeletionStatus.mockResolvedValue(NO_DELETION);
  mocks.startAccountDeletion.mockResolvedValue(status({ state: "completed" }));
  mocks.reauthenticateWithGoogle.mockResolvedValue(undefined);
  mocks.reauthenticateWithPassword.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  // Flush the modal's delayed post-success cleanup (local purge + sign out,
  // scheduled 1.5s after the success message) so a real-timer success test
  // can never leak those calls into the next test.
  vi.useFakeTimers();
  vi.advanceTimersByTime(2000);
  vi.useRealTimers();
});

describe("DeleteAccountModal", () => {
  it("keeps permanent deletion disabled until DELETE is typed exactly", async () => {
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();
    const button = getConfirmButton();

    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "" } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "delete" } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "DELETE " } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "DELETEX" } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(button).toBeEnabled();
  });

  it("explains what is deleted and never exposes a generic OK button", async () => {
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    expect(
      await screen.findByText("Delete your Nexuss account?")
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Deleting your account permanently removes your Nexuss account and associated data/i
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("does not call the API when confirmation text is wrong", async () => {
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();
    fireEvent.change(input, { target: { value: "delete" } });
    fireEvent.click(getConfirmButton());
    expect(mocks.startAccountDeletion).not.toHaveBeenCalled();
    expect(mocks.reauthenticateWithGoogle).not.toHaveBeenCalled();
  });

  it("re-authenticates with Google before starting a Google account deletion", async () => {
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();
    fireEvent.change(input, { target: { value: "DELETE" } });
    fireEvent.click(getConfirmButton());

    await act(async () => {});
    expect(mocks.reauthenticateWithGoogle).toHaveBeenCalledTimes(1);
    expect(mocks.startAccountDeletion).toHaveBeenCalledTimes(1);
  });

  it("requires the password for password-authenticated accounts", async () => {
    mocks.getReauthMethod.mockReturnValue("password");
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();

    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(getConfirmButton()).toBeDisabled();
    expect(mocks.reauthenticateWithPassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm your password"), {
      target: { value: "hunter2" }
    });
    expect(getConfirmButton()).toBeEnabled();

    fireEvent.click(getConfirmButton());
    await act(async () => {});
    expect(mocks.reauthenticateWithPassword).toHaveBeenCalledWith("hunter2");
    expect(mocks.startAccountDeletion).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed re-authentication and never starts the deletion", async () => {
    mocks.reauthenticateWithGoogle.mockRejectedValueOnce(new Error("Popup was closed"));
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();

    fireEvent.change(input, { target: { value: "DELETE" } });
    fireEvent.click(getConfirmButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your account was not deleted.");
    expect(alert).toHaveTextContent("Popup was closed");
    expect(mocks.startAccountDeletion).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(getConfirmButton()).toBeEnabled();
  });

  it("surfaces a real failure and does not fake success", async () => {
    mocks.startAccountDeletion.mockRejectedValueOnce(new Error("Backend unavailable"));
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();

    fireEvent.change(input, { target: { value: "DELETE" } });
    fireEvent.click(getConfirmButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your account was not deleted.");
    expect(alert).toHaveTextContent("Backend unavailable");
    expect(screen.queryByText(/permanently deleted/i)).not.toBeInTheDocument();
    expect(mocks.purgeLocalAccountData).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();

    // Retry is still available after a failure.
    expect(getConfirmButton()).toBeEnabled();
  });

  it("deletes, clears local account data, then signs out after confirming", async () => {
    vi.useFakeTimers();
    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();

    fireEvent.change(input, { target: { value: "DELETE" } });
    fireEvent.click(getConfirmButton());

    await act(async () => {});

    expect(mocks.startAccountDeletion).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your Nexuss account has been permanently deleted."
    );
    // Local cleanup + sign out happen only after the success message.
    expect(mocks.purgeLocalAccountData).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    await act(async () => {});

    expect(mocks.purgeLocalAccountData).toHaveBeenCalledWith("uid-123");
    expect(mocks.clearAuthCache).toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("polls the backend until the running deletion completes", async () => {
    vi.useFakeTimers();
    mocks.startAccountDeletion.mockResolvedValue(
      status({ state: "running", stage: "deleting_data", detail: "Deletion started." })
    );
    mocks.getDeletionStatus
      .mockResolvedValueOnce(NO_DELETION)
      .mockResolvedValue(status({ state: "completed", stage: "verifying" }));

    render(<DeleteAccountModal isOpen onClose={() => {}} />);
    const input = await openConfirmView();
    fireEvent.change(input, { target: { value: "DELETE" } });
    fireEvent.click(getConfirmButton());
    await act(async () => {});

    expect(screen.getByRole("status")).toHaveTextContent(
      "Removing your data from Nexuss servers"
    );
    expect(
      screen.queryByText("Your Nexuss account has been permanently deleted.")
    ).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    await act(async () => {});

    expect(screen.getByRole("status")).toHaveTextContent(
      "Your Nexuss account has been permanently deleted."
    );
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    await act(async () => {});
    expect(mocks.purgeLocalAccountData).toHaveBeenCalledWith("uid-123");
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("resumes a deletion that is already running when the dialog opens", async () => {
    mocks.getDeletionStatus.mockResolvedValue(
      status({ state: "running", stage: "removing_auth", attempt: 2, detail: "Still working." })
    );
    const onClose = vi.fn();
    render(<DeleteAccountModal isOpen onClose={onClose} />);

    expect(await screen.findByText(/Your account is being permanently deleted/i)).toBeInTheDocument();
    expect(screen.getByText("Removing your Firebase sign-in account")).toBeInTheDocument();
    expect(screen.getByText(/Attempt 2/)).toBeInTheDocument();
    expect(screen.queryByLabelText(CONFIRM)).not.toBeInTheDocument();

    // No dismissal while the job runs: neither the ✕ nor Escape works.
    fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers an explicit retry once the bounded retries are exhausted", async () => {
    mocks.getDeletionStatus.mockResolvedValue(
      status({ state: "failed", stage: "removing_auth", detail: "Automatic retries stopped." })
    );
    const onClose = vi.fn();
    render(<DeleteAccountModal isOpen onClose={onClose} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Deletion did not finish.");
    expect(mocks.startAccountDeletion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry deletion" }));
    await act(async () => {});
    expect(mocks.startAccountDeletion).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your Nexuss account has been permanently deleted."
    );
  });

  it("cannot be dismissed while the deletion is in flight", async () => {
    vi.useFakeTimers();
    let resolveDelete: (value?: unknown) => void = () => {};
    mocks.startAccountDeletion.mockImplementation(
      () => new Promise((resolve) => (resolveDelete = resolve))
    );
    const onClose = vi.fn();
    render(<DeleteAccountModal isOpen onClose={onClose} />);
    const input = await openConfirmView();

    fireEvent.change(input, { target: { value: "DELETE" } });
    fireEvent.click(getConfirmButton());

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toBeDisabled();
    fireEvent.click(cancelButton);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveDelete(status({ state: "running" }));
    });
  });

  it("closes through Cancel when idle", async () => {
    const onClose = vi.fn();
    render(<DeleteAccountModal isOpen onClose={onClose} />);
    await openConfirmView();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
