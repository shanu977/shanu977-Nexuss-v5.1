"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DataTable, type ColumnDef } from "@/components/admin/DataTable";
import { SearchBar } from "@/components/admin/SearchBar";
import { FilterDropdown } from "@/components/admin/FilterDropdown";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmationModal } from "@/components/admin/ConfirmationModal";
import { SkeletonLoader, ErrorState } from "@/components/admin/States";
import { adminApi } from "@/services/admin";
import type { AdminUser, AdminUserList, UserRole } from "@/types/admin";
import { formatDate } from "@/utils/format";
import { Users, UserCheck, ShieldOff, Eye, Ban, Trash2, X, Shield } from "lucide-react";

function UserAvatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        style={{ width: "36px", height: "36px", borderRadius: "50%", objectFit: "cover" }}
      />
    );
  }
  return (
    <div
      style={{
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        backgroundColor: "var(--accent-primary-light)",
        color: "var(--accent-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: "0.9rem",
        flexShrink: 0,
      }}
    >
      {(name || "?").trim().charAt(0).toUpperCase()}
    </div>
  );
}

interface SummaryCounts {
  total: number;
  active: number;
  blocked: number;
}

export default function AdminUsersPage() {
  const [usersData, setUsersData] = useState<AdminUserList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<SummaryCounts | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [page, setPage] = useState(1);

  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [blockModalUser, setBlockModalUser] = useState<AdminUser | null>(null);
  const [deleteModalUser, setDeleteModalUser] = useState<AdminUser | null>(null);
  const [roleModalUser, setRoleModalUser] = useState<AdminUser | null>(null);
  const [pendingRole, setPendingRole] = useState<UserRole>("user");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getUsers({
        page,
        page_size: 20,
        search: search || undefined,
        status: statusFilter === "All" ? undefined : (statusFilter.toLowerCase() as "active" | "blocked"),
      });
      setUsersData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load user accounts.");
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, page]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const fetchSummary = useCallback(async () => {
    try {
      const [allUsers, activeUsers, blockedUsers] = await Promise.all([
        adminApi.getUsers({ page: 1, page_size: 1 }),
        adminApi.getUsers({ page: 1, page_size: 1, status: "active" }),
        adminApi.getUsers({ page: 1, page_size: 1, status: "blocked" }),
      ]);
      setSummary({ total: allUsers.total, active: activeUsers.total, blocked: blockedUsers.total });
    } catch {
      // Summary cards are best-effort; the table still renders.
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const refreshAll = useCallback(() => {
    fetchUsers();
    fetchSummary();
  }, [fetchUsers, fetchSummary]);

  const showActionError = (err: unknown) => {
    setActionError(err instanceof Error ? err.message : "The action could not be completed.");
  };

  const handleBlockToggle = async () => {
    if (!blockModalUser) return;
    setActionLoading(true);
    setActionError(null);
    try {
      if (blockModalUser.status === "active") {
        await adminApi.blockUser(blockModalUser.id);
      } else {
        await adminApi.unblockUser(blockModalUser.id);
      }
      setBlockModalUser(null);
      refreshAll();
    } catch (err) {
      showActionError(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteModalUser) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await adminApi.deleteUser(deleteModalUser.id);
      setDeleteModalUser(null);
      if (selectedUser?.id === deleteModalUser.id) setShowDetailModal(false);
      refreshAll();
    } catch (err) {
      showActionError(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRoleChange = async () => {
    if (!roleModalUser) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const updated = await adminApi.updateRole(roleModalUser.id, pendingRole);
      setRoleModalUser(null);
      setSelectedUser(updated);
      refreshAll();
    } catch (err) {
      showActionError(err);
    } finally {
      setActionLoading(false);
    }
  };

  const columns = useMemo<ColumnDef<AdminUser>[]>(() => [
    {
      header: "User",
      key: "user",
      render: (row) => (
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <UserAvatar name={row.name || row.email} photoUrl={row.photo_url} />
          <div>
            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{row.name || row.email}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{row.email}</div>
          </div>
        </div>
      ),
    },
    {
      header: "Role",
      key: "role",
      render: (row) => <StatusBadge status={row.role} />,
    },
    {
      header: "Status",
      key: "status",
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      header: "Provider",
      key: "provider",
      render: (row) => <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{row.provider}</span>,
    },
    {
      header: "Joined",
      key: "created_at",
      render: (row) => <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{formatDate(row.created_at)}</span>,
    },
    {
      header: "Actions",
      key: "actions",
      render: (row) => (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            onClick={() => {
              setSelectedUser(row);
              setActionError(null);
              setShowDetailModal(true);
            }}
            title="View Details"
            aria-label={`View ${row.email}`}
            style={iconBtnStyle}
          >
            <Eye size={14} />
          </button>
          <button
            onClick={() => {
              setActionError(null);
              setBlockModalUser(row);
            }}
            title={row.status === "active" ? "Block User" : "Unblock User"}
            aria-label={row.status === "active" ? `Block ${row.email}` : `Unblock ${row.email}`}
            style={{
              ...iconBtnStyle,
              backgroundColor: row.status === "active" ? "var(--color-warning-bg)" : "var(--color-success-bg)",
              border: "none",
              color: row.status === "active" ? "var(--color-warning)" : "var(--color-success)",
            }}
          >
            <Ban size={14} />
          </button>
          <button
            onClick={() => {
              setActionError(null);
              setDeleteModalUser(row);
            }}
            title="Delete User"
            aria-label={`Delete ${row.email}`}
            style={{
              ...iconBtnStyle,
              backgroundColor: "var(--color-danger-bg)",
              border: "none",
              color: "var(--color-danger)",
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ], []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>
          User Directory & Access Control
        </h1>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>
          Manage platform accounts, roles, and account access
        </p>
      </div>

      {/* Summary Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
        <SummaryCard icon={<Users size={20} />} bg="var(--accent-primary-light)" color="var(--accent-primary)" label="Total Registered" value={summary?.total} />
        <SummaryCard icon={<UserCheck size={20} />} bg="var(--color-success-bg)" color="var(--color-success)" label="Active Accounts" value={summary?.active} />
        <SummaryCard icon={<ShieldOff size={20} />} bg="var(--color-danger-bg)" color="var(--color-danger)" label="Blocked / Suspended" value={summary?.blocked} />
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
        <SearchBar
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder="Search users by name or email..."
        />
        <FilterDropdown
          value={statusFilter}
          onChange={(val) => {
            setStatusFilter(val);
            setPage(1);
          }}
          options={[
            { label: "All Statuses", value: "All" },
            { label: "Active", value: "Active" },
            { label: "Blocked", value: "Blocked" },
          ]}
        />
      </div>

      {actionError && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--color-danger-bg)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            color: "var(--color-danger)",
            fontSize: "0.82rem",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ flex: 1 }}>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss" style={{ color: "var(--color-danger)" }}>
            <X size={16} />
          </button>
        </div>
      )}

      {loading && !usersData ? (
        <SkeletonLoader height="60px" count={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchUsers} />
      ) : (
        <DataTable
          columns={columns}
          data={usersData?.items ?? []}
          pagination={
            usersData
              ? {
                  page: usersData.page,
                  totalPages: usersData.pages,
                  totalCount: usersData.total,
                }
              : undefined
          }
          onPageChange={setPage}
          emptyMessage="No users matching the search criteria"
        />
      )}

      {/* User Details Modal */}
      {showDetailModal && selectedUser && (
        <div className="admin-modal-overlay" onClick={() => setShowDetailModal(false)}>
          <div
            className="admin-glass-panel admin-animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "560px",
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <UserAvatar name={selectedUser.name || selectedUser.email} photoUrl={selectedUser.photo_url} />
                <div>
                  <h3 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>
                    {selectedUser.name || selectedUser.email}
                  </h3>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{selectedUser.email}</div>
                </div>
              </div>
              <button onClick={() => setShowDetailModal(false)} aria-label="Close" style={{ color: "var(--text-muted)", padding: "4px" }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", padding: "14px", borderRadius: "var(--radius-md)", backgroundColor: "var(--bg-app)", border: "1px solid var(--border-subtle)" }}>
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Status</span>
                <div style={{ marginTop: "4px" }}>
                  <StatusBadge status={selectedUser.status} />
                </div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Role</span>
                <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>{selectedUser.role}</div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Provider</span>
                <div style={{ fontSize: "0.85rem", fontWeight: 500, color: "var(--text-primary)" }}>{selectedUser.provider}</div>
              </div>
              <div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Joined</span>
                <div style={{ fontSize: "0.85rem", fontWeight: 500, color: "var(--text-primary)" }}>{formatDate(selectedUser.created_at)}</div>
              </div>
            </div>

            <div
              style={{
                padding: "14px",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--bg-app)",
                border: "1px solid var(--border-subtle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "12px",
              }}
            >
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Change Role</div>
                <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                  Promote to admin or demote back to user
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <select
                  value={selectedUser.role}
                  onChange={(e) => setPendingRole(e.target.value as UserRole)}
                  aria-label="Select role"
                  style={{
                    padding: "8px 12px",
                    fontSize: "0.85rem",
                    color: "var(--text-primary)",
                    backgroundColor: "var(--bg-input)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-md)",
                    outline: "none",
                  }}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  onClick={() => {
                    setPendingRole(selectedUser.role);
                    setActionError(null);
                    setRoleModalUser(selectedUser);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "8px 14px",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--border-subtle)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-color)",
                  }}
                >
                  <Shield size={14} /> Change Role
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Block / Unblock Confirmation */}
      <ConfirmationModal
        isOpen={Boolean(blockModalUser)}
        onClose={() => setBlockModalUser(null)}
        onConfirm={handleBlockToggle}
        title={blockModalUser?.status === "active" ? "Block User Account?" : "Unblock User Account?"}
        message={
          blockModalUser?.status === "active"
            ? `Are you sure you want to block ${blockModalUser?.name || blockModalUser?.email}? They will immediately lose access to the application and AI features.`
            : `Re-activate access for ${blockModalUser?.name || blockModalUser?.email}?`
        }
        confirmText={blockModalUser?.status === "active" ? "Block Account" : "Unblock Account"}
        isDanger={blockModalUser?.status === "active"}
        isLoading={actionLoading}
      />

      {/* Delete Confirmation */}
      <ConfirmationModal
        isOpen={Boolean(deleteModalUser)}
        onClose={() => setDeleteModalUser(null)}
        onConfirm={handleDeleteUser}
        title="Delete User Permanently?"
        message={`This operation deletes or resets ${deleteModalUser?.name || deleteModalUser?.email}'s application data. Because the app user id is the Firebase uid, the account may be re-provisioned as a fresh account on their next login. This cannot be undone.`}
        confirmText="Delete User"
        isDanger={true}
        isLoading={actionLoading}
      />

      {/* Role Change Confirmation */}
      <ConfirmationModal
        isOpen={Boolean(roleModalUser)}
        onClose={() => setRoleModalUser(null)}
        onConfirm={handleRoleChange}
        title={`Change role to "${pendingRole}"?`}
        message={`${roleModalUser?.name || roleModalUser?.email} will be granted ${pendingRole === "admin" ? "full administrator access to the Admin panel." : "standard user access only."} The backend enforces this change.`}
        confirmText="Change Role"
        isDanger={pendingRole === "user"}
        isLoading={actionLoading}
      />
    </div>
  );
}

function SummaryCard({ icon, bg, color, label, value }: { icon: ReactNode; bg: string; color: string; label: string; value?: number }) {
  return (
    <div className="admin-glass-panel" style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: "14px" }}>
      <div style={{ padding: "10px", borderRadius: "var(--radius-md)", backgroundColor: bg, color }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{label}</div>
        <div style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>
          {value === undefined ? "—" : value.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle: CSSProperties = {
  padding: "6px",
  borderRadius: "var(--radius-sm)",
  backgroundColor: "var(--bg-app)",
  border: "1px solid var(--border-color)",
  color: "var(--text-secondary)",
};
