// No DOM needed: renderToStaticMarkup runs no effects and both primitives are pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Trash2 } from "lucide-react";
import { DataTable, RowActionsMenu, type DataTableColumn } from "./data-table";
import { StatusPill } from "./status-pill";

interface Row {
  id: string;
  name: string;
}

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Mailbox", width: "1fr", cell: (r) => r.name },
];

const rows: Row[] = [
  { id: "a", name: "hydra@oblien.com" },
  { id: "b", name: "security@oblien.com" },
];

function renderTable() {
  return renderToStaticMarkup(
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      rowActions={(r) => (
        <RowActionsMenu
          label={`Actions for ${r.name}`}
          actions={[
            {
              id: "delete",
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              variant: "danger",
              onClick: () => {},
            },
          ]}
        />
      )}
    />,
  );
}

describe("DataTable row actions", () => {
  it("puts every row action behind one ⋯ trigger, closed at rest", () => {
    const html = renderTable();
    expect(html).toContain('aria-label="Actions for hydra@oblien.com"');
    expect(html).toContain('aria-expanded="false"');
    // The destructive action must not be reachable without opening the menu.
    expect(html).not.toContain(">Delete<");
  });

  it("does not clip the menu: the card carries no overflow-hidden", () => {
    // DropdownMenu renders its panel in-flow, so overflow-hidden here would make
    // the LAST row's menu invisible — layout-only, which no DOM assertion sees.
    // Guard the class instead.
    expect(renderTable()).not.toContain("overflow-hidden");
  });
});

describe("StatusPill", () => {
  it("is a tinted fill with no outline and no leading dot", () => {
    const html = renderToStaticMarkup(<StatusPill tone="success">Active</StatusPill>);
    expect(html).toContain("bg-success-bg");
    expect(html).toContain("text-success");
    expect(html).not.toContain("border");
    // A dot would be an empty rounded-full span before the label.
    expect(html).not.toContain("rounded-full bg-success-solid");
  });
});
