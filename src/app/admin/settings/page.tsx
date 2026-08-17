"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ToggleSwitch } from "@/components/admin/ToggleSwitch";
import { ConfirmationModal } from "@/components/admin/ConfirmationModal";
import { SkeletonLoader, ErrorState } from "@/components/admin/States";
import { adminApi } from "@/services/admin";
import type { AdminSetting, AdminSettingUpsert, SettingValueType } from "@/types/admin";
import { Sliders, CheckCircle2, X, Plus, AlertCircle, Save } from "lucide-react";

interface PendingDisable {
  key: string;
  label: string;
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: "0.85rem",
  color: "var(--text-primary)",
  backgroundColor: "var(--bg-input)",
  border: "1px solid var(--border-color)",
  borderRadius: "var(--radius-md)",
  outline: "none",
};

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [toastMessage, setToastMessage] = useState("");
  const [pendingDisable, setPendingDisable] = useState<PendingDisable | null>(null);

  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [newKey, setNewKey] = useState("");
  const [newValueType, setNewValueType] = useState<SettingValueType>("string");
  const [newValue, setNewValue] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(""), 3500);
  };

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getSettings();
      setSettings(res.items);
      const drafts: Record<string, string> = {};
      res.items.forEach((s) => {
        drafts[s.key] = s.value;
      });
      setDrafts(drafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load admin system settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveItems = async (items: AdminSettingUpsert[]) => {
    setSaving(true);
    setError(null);
    try {
      const res = await adminApi.updateSettings(items);
      setSettings(res.items);
      const drafts = { ...(res.items.reduce<Record<string, string>>((acc, s) => {
        acc[s.key] = s.value;
        return acc;
      }, {})) };
      setDrafts(drafts);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save settings.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleBooleanToggle = async (setting: AdminSetting, nextValue: boolean) => {
    const label = setting.description || setting.key;
    if (nextValue === false) {
      setPendingDisable({ key: setting.key, label });
      return;
    }
    const ok = await saveItems([
      { key: setting.key, value: "true", value_type: "boolean", description: setting.description },
    ]);
    if (ok) showToast(`"${label}" has been enabled.`);
  };

  const handleConfirmDisable = async () => {
    if (!pendingDisable) return;
    const setting = settings.find((s) => s.key === pendingDisable.key);
    if (setting) {
      const ok = await saveItems([
        { key: setting.key, value: "false", value_type: "boolean", description: setting.description },
      ]);
      if (ok) showToast(`"${pendingDisable.label}" has been disabled.`);
    }
    setPendingDisable(null);
  };

  const handleSaveDraft = async (setting: AdminSetting) => {
    const nextValue = (drafts[setting.key] ?? "").trim();
    if (nextValue === setting.value) return;
    const ok = await saveItems([
      { key: setting.key, value: nextValue, value_type: setting.value_type, description: setting.description },
    ]);
    if (ok) showToast(`"${setting.key}" updated.`);
  };

  const handleAddSetting = async () => {
    if (!newKey.trim()) return;
    const ok = await saveItems([
      {
        key: newKey.trim(),
        value: newValue,
        value_type: newValueType,
        description: newDescription.trim() || null,
      },
    ]);
    if (ok) {
      showToast(`Setting "${newKey.trim()}" added.`);
      setNewKey("");
      setNewValue("");
      setNewDescription("");
      setNewValueType("string");
    }
  };

  if (loading && settings.length === 0) {
    return <SkeletonLoader height="120px" count={3} />;
  }

  if (error && settings.length === 0) {
    return <ErrorState message={error} onRetry={fetchSettings} />;
  }

  const featureFlags = settings.filter((s) => s.value_type === "boolean");
  const otherSettings = settings.filter((s) => s.value_type !== "boolean");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "1000px", position: "relative" }}>
      {toastMessage && (
        <div
          className="admin-animate-slide-up"
          role="status"
          style={{
            position: "fixed",
            top: "24px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "12px 24px",
            borderRadius: "var(--radius-md)",
            backgroundColor: "#111416",
            border: "1px solid var(--accent-primary)",
            boxShadow: "0 12px 40px rgba(0, 0, 0, 0.9)",
            color: "var(--text-primary)",
            fontSize: "0.88rem",
            fontWeight: 600,
            maxWidth: "90vw",
          }}
        >
          <CheckCircle2 size={20} style={{ color: "var(--accent-primary)", flexShrink: 0 }} />
          <span>{toastMessage}</span>
          <button onClick={() => setToastMessage("")} aria-label="Dismiss" style={{ color: "var(--text-muted)", marginLeft: "12px", padding: "2px" }}>
            <X size={16} />
          </button>
        </div>
      )}

      <div>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>
          System & Global Settings
        </h1>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: "2px" }}>
          Global feature flags and application configuration. Never stores secrets or provider API keys.
        </p>
      </div>

      {error && (
        <div
          role="alert"
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
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss" style={{ color: "var(--color-danger)" }}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* 1. Feature Flags */}
      <div className="admin-glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Sliders size={20} style={{ color: "var(--accent-primary)" }} />
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--text-primary)" }}>Feature Flags</h3>
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Boolean settings rendered as on/off toggles
            </p>
          </div>
        </div>

        {featureFlags.length === 0 ? (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "8px 0" }}>
            No boolean settings defined yet. Use the form below to add one.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
            {featureFlags.map((setting) => (
              <div
                key={setting.key}
                style={{
                  padding: "16px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-app)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)" }}>{setting.key}</div>
                  {setting.description && (
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>{setting.description}</div>
                  )}
                </div>
                <ToggleSwitch
                  checked={setting.value === "true"}
                  disabled={saving}
                  label={setting.key}
                  onChange={(val) => handleBooleanToggle(setting, val)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Configuration */}
      <div className="admin-glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>
          <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--text-primary)" }}>Configuration</h3>
          <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "2px" }}>
            String, number, and JSON settings with inline editing
          </p>
        </div>

        {otherSettings.length === 0 ? (
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", padding: "8px 0" }}>
            No configuration settings defined yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {otherSettings.map((setting) => (
              <div
                key={setting.key}
                style={{
                  padding: "14px 18px",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-app)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                    <code style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--accent-primary)", fontFamily: "monospace" }}>
                      {setting.key}
                    </code>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", backgroundColor: "var(--border-subtle)", padding: "2px 8px", borderRadius: "var(--radius-full)" }}>
                      {setting.value_type}
                    </span>
                  </div>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                    {setting.updated_by_email ? `Updated by ${setting.updated_by_email}` : "Never updated"}
                  </span>
                </div>

                {setting.description && (
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{setting.description}</div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: "220px" }}>
                    <input
                      type="text"
                      value={drafts[setting.key] ?? ""}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [setting.key]: e.target.value }))}
                      aria-label={`Edit value for ${setting.key}`}
                      style={inputStyle}
                    />
                  </div>
                  <button
                    onClick={() => handleSaveDraft(setting)}
                    disabled={saving || (drafts[setting.key] ?? "").trim() === setting.value}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "8px 16px",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      borderRadius: "var(--radius-md)",
                      backgroundColor: "var(--accent-primary)",
                      color: "#ffffff",
                      border: "none",
                      opacity: saving || (drafts[setting.key] ?? "").trim() === setting.value ? 0.6 : 1,
                      cursor: saving ? "not-allowed" : "pointer",
                    }}
                  >
                    <Save size={14} /> Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Add Setting */}
      <div className="admin-glass-panel" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Plus size={20} style={{ color: "var(--color-info)" }} />
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--text-primary)" }}>Add Setting</h3>
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Create a new global setting. Keys may not contain secrets or credentials.
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Key</label>
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="feature:flag-name"
              style={{ ...inputStyle, marginTop: "4px" }}
            />
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Type</label>
            <select
              value={newValueType}
              onChange={(e) => setNewValueType(e.target.value as SettingValueType)}
              style={{ ...inputStyle, marginTop: "4px" }}
            >
              <option value="string">string</option>
              <option value="boolean">boolean</option>
              <option value="number">number</option>
              <option value="json">json</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Value</label>
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={'true, 42, hello, {"a":1}'}
              style={{ ...inputStyle, marginTop: "4px" }}
            />
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>Description</label>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="What this setting controls"
              style={{ ...inputStyle, marginTop: "4px" }}
            />
          </div>
        </div>

        <div>
          <button
            onClick={handleAddSetting}
            disabled={saving || !newKey.trim()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 18px",
              fontSize: "0.82rem",
              fontWeight: 600,
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--color-info)",
              color: "#ffffff",
              border: "none",
              opacity: saving || !newKey.trim() ? 0.6 : 1,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            <Plus size={14} /> Add Setting
          </button>
        </div>
      </div>

      <ConfirmationModal
        isOpen={Boolean(pendingDisable)}
        onClose={() => setPendingDisable(null)}
        onConfirm={handleConfirmDisable}
        title={`Disable "${pendingDisable?.label}"?`}
        message={`Are you sure you want to turn off ${pendingDisable?.label}? This disables the setting across the entire platform.`}
        confirmText="Yes, Turn Off"
        cancelText="Cancel"
        isDanger={true}
        isLoading={saving}
      />
    </div>
  );
}
