import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DataTable, type ColumnDef } from "@/components/admin/DataTable";

afterEach(() => {
  cleanup();
});

interface Row {
  id: string;
  name: string;
  email: string;
}

const rows: Row[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
];

describe("DataTable", () => {
  it("renders headers and default column values", () => {
    render(<DataTable columns={[{ key: "name", header: "Name" }]} data={rows} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("uses custom render functions", () => {
    const columns: ColumnDef<Row>[] = [
      {
        key: "email",
        header: "User",
        render: (row) => <span data-testid="email-cell">{row.email}</span>,
      },
    ];
    render(<DataTable columns={columns} data={rows} />);
    expect(screen.getAllByTestId("email-cell")).toHaveLength(2);
  });

  it("shows empty message when there is no data", () => {
    render(<DataTable columns={[{ key: "name", header: "Name" }]} data={[]} emptyMessage="No users" />);
    expect(screen.getByText("No users")).toBeInTheDocument();
  });

  it("notifies pagination changes", () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={[{ key: "name", header: "Name" }]}
        data={rows}
        pagination={{ page: 2, totalPages: 3, totalCount: 60 }}
        onPageChange={onPageChange}
      />
    );
    expect(screen.getByText(/Showing page 2 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});