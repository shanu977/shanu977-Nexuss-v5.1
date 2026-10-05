import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsContent from "@/components/SettingsContent";
import AccountPanel from "@/components/AccountPanel";

const mocks = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  fetchServerExport: vi.fn(),
  downloadJson: vi.fn(),
  gatherLocalAccountExport: vi.fn(),
  getDeletionStatus: vi.fn(),
  getReauthMethod: vi.fn(),
  useAuthStore: vi.fn(),
  useWorkspaceStore: vi.fn()
}));

vi.mock("@/services/account", () => ({
  getAccountInfo: mocks.getAccountInfo,
  fetchServerExport: mocks.fetchServerExport,
  downloadJson: mocks.downloadJson,
  getDeletionStatus: mocks.getDeletionStatus,
  getReauthMethod: mocks.getReauthMethod,
  DELETION_STAGE_LABELS: {
    queued: "Deletion queued",
    deleting_data: "Removing your data from Nexuss servers",
    removing_auth: "Removing your Firebase sign-in account",
    verifying: "Verifying that nothing was left behind"
  }
}));
vi.mock("@/services/accountData", () => ({
  gatherLocalAccountExport: mocks.gatherLocalAccountExport,
  purgeLocalAccountData: vi.fn()
}));
vi.mock("@/store/useAuthStore", () => ({ useAuthStore: mocks.useAuthStore }));
vi.mock("@/workspace/store", () => ({ useWorkspaceStore: mocks.useWorkspaceStore }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAccountInfo.mockResolvedValue({
    email: "alice@nexuss.in",
    name: "Alice",
    provider: "password",
    created_at: Date.UTC(2025, 0, 15)
  });
  mocks.getDeletionStatus.mockResolvedValue({
    state: "none",
    stage: null,
    attempt: 0,
    next_attempt_at: null,
    last_error: null,
    detail: null
  });
  mocks.getReauthMethod.mockReturnValue("password");
  mocks.useAuthStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ user: { uid: "uid-1", email: "alice@nexuss.in", displayName: "" } })
  );
  mocks.useWorkspaceStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ workspace: { name: "My Project", root: "/tmp/x" } })
  );
});

afterEach(() => {
  cleanup();
});

describe("SettingsContent account tab", () => {
  it("shows the Account panel when opened directly on the account tab", async () => {
    render(<SettingsContent initialTab="account" />);

    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("Account Information")).toBeInTheDocument();
    expect(screen.getByText("Data & Privacy")).toBeInTheDocument();
    expect(screen.getByText("Danger Zone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export my data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Account" })).toBeInTheDocument();
    expect(screen.getAllByText("My Project").length).toBeGreaterThanOrEqual(2);

    expect((await screen.findAllByText("alice@nexuss.in")).length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText(/January 15, 2025/)).toBeInTheDocument();
  });

  it("stays on Preferences when no tab is requested", async () => {
    render(<SettingsContent />);
    expect(screen.getByText("Preferences")).toBeInTheDocument();
    expect(screen.queryByText("Danger Zone")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete Account")).not.toBeInTheDocument();
  });

  it("switches to the Account panel when the Account tab is clicked", async () => {
    render(<SettingsContent />);
    expect(screen.queryByText("Danger Zone")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(await screen.findByText("Danger Zone")).toBeInTheDocument();
    expect(screen.getByText("Account Information")).toBeInTheDocument();
  });

  it("tells the truth when live account details cannot be loaded", async () => {
    mocks.getAccountInfo.mockRejectedValueOnce(new Error("Backend unavailable"));
    render(<SettingsContent initialTab="account" />);

    expect(
      await screen.findByText(/Live account details could not be loaded: Backend unavailable/)
    ).toBeInTheDocument();
    // The panel still renders the fallback identity instead of inventing data.
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(1);
  });
});

describe("AccountPanel data and privacy", () => {
  it("states that API keys are never exported and chat history stays local", async () => {
    render(<AccountPanel />);

    expect(
      await screen.findByText(/stored encrypted on Nexuss servers. They are never shown here or included in an export/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/live in your browser's IndexedDB and are not synced to Nexuss servers/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No chat content is recorded/)
    ).toBeInTheDocument();
  });

  it("exports server and local data as one JSON download", async () => {
    mocks.fetchServerExport.mockResolvedValue({ users: [] });
    mocks.gatherLocalAccountExport.mockResolvedValue({ chats: [], notes: [] });
    render(<AccountPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Export my data" }));

    await waitFor(() => expect(mocks.downloadJson).toHaveBeenCalledTimes(1));
    expect(mocks.fetchServerExport).toHaveBeenCalledTimes(1);
    expect(mocks.gatherLocalAccountExport).toHaveBeenCalledWith("uid-1");
    expect(mocks.downloadJson.mock.calls[0][0]).toMatch(/^nexuss-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(mocks.downloadJson.mock.calls[0][1]).toMatchObject({ server: { users: [] } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your Nexuss data was downloaded as a JSON file."
    );
  });

  it("keeps export failures honest", async () => {
    mocks.fetchServerExport.mockRejectedValue(new Error("Export failed"));
    mocks.gatherLocalAccountExport.mockResolvedValue({ chats: [] });
    render(<AccountPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Export my data" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Export failed");
    expect(mocks.downloadJson).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export my data" })).toBeEnabled();
  });

  it("opens the DELETE confirmation dialog from the Danger Zone", async () => {
    render(<AccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Account" }));

    expect(await screen.findByText("Delete your Nexuss account?")).toBeInTheDocument();
    expect(await screen.findByLabelText("Type DELETE to confirm")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm your password")).toBeInTheDocument();
  });

  it("shows a live deletion banner instead of the delete button while a job runs", async () => {
    mocks.getDeletionStatus.mockResolvedValue({
      state: "running",
      stage: "removing_auth",
      attempt: 1,
      next_attempt_at: null,
      last_error: null,
      detail: null
    });
    render(<AccountPanel />);

    expect(
      await screen.findByText("Your account is being permanently deleted.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Removing your Firebase sign-in account")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Account" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View deletion progress" })
    ).toBeInTheDocument();
    // The locked account must not offer data export either.
    expect(screen.getByRole("button", { name: "Export my data" })).toBeDisabled();
    // Profile facts are not fetched while the account is frozen.
    expect(mocks.getAccountInfo).not.toHaveBeenCalled();
  });

  it("offers a retry when the bounded retries are exhausted", async () => {
    mocks.getDeletionStatus.mockResolvedValue({
      state: "failed",
      stage: "removing_auth",
      attempt: 7,
      next_attempt_at: null,
      last_error: "removing_auth failed (ValueError)",
      detail: "Deletion could not be completed automatically. Please retry."
    });
    render(<AccountPanel />);

    expect(await screen.findByText("Account deletion did not finish.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry deletion" }));
    expect(await screen.findByText("Delete your Nexuss account?")).toBeInTheDocument();
  });
});
