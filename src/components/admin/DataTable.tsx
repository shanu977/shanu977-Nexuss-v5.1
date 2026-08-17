import { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface PaginationInfo {
  page: number;
  totalPages: number;
  totalCount: number;
}

export interface ColumnDef<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  pagination?: PaginationInfo;
  onPageChange?: (page: number) => void;
  emptyMessage?: string;
}

export function DataTable<T extends { id?: string }>({
  columns = [],
  data = [],
  pagination,
  onPageChange,
  emptyMessage = "No records found",
}: DataTableProps<T>) {
  return (
    <div className="admin-glass-panel" style={{ width: "100%", overflow: "hidden" }}>
      <div style={{ width: "100%", overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            textAlign: "left",
            fontSize: "0.85rem",
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--border-color)",
                backgroundColor: "rgba(255, 255, 255, 0.02)",
              }}
            >
              {columns.map((col, idx) => (
                <th
                  key={col.key || idx}
                  style={{
                    padding: "12px 16px",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                  }}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row, rowIdx) => (
                <tr
                  key={row.id || rowIdx}
                  style={{
                    borderBottom: "1px solid var(--border-subtle)",
                    transition: "background-color var(--transition-fast)",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.02)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  {columns.map((col, colIdx) => (
                    <td
                      key={col.key || colIdx}
                      style={{
                        padding: "14px 16px",
                        color: "var(--text-primary)",
                        verticalAlign: "middle",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col.render ? col.render(row) : (row as Record<string, ReactNode>)[col.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && onPageChange && (
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid var(--border-color)",
            backgroundColor: "rgba(0, 0, 0, 0.2)",
            fontSize: "0.8rem",
            color: "var(--text-secondary)",
          }}
        >
          <div>
            Showing page {pagination.page} of {pagination.totalPages} ({pagination.totalCount} items)
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={() => onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--bg-app)",
                border: "1px solid var(--border-color)",
                color: pagination.page <= 1 ? "var(--text-muted)" : "var(--text-primary)",
                cursor: pagination.page <= 1 ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <ChevronLeft size={14} /> Previous
            </button>
            <button
              onClick={() => onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--bg-app)",
                border: "1px solid var(--border-color)",
                color: pagination.page >= pagination.totalPages ? "var(--text-muted)" : "var(--text-primary)",
                cursor: pagination.page >= pagination.totalPages ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
