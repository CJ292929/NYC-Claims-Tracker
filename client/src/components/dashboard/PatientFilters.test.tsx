// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PatientFilters } from "./PatientFilters";
import { historicalInsurerNames } from "@/lib/patientFilters";

afterEach(cleanup);

// P4-P22: after a referenced insurer is permanently deleted, it leaves the
// catalog list but its patients stay findable under "Historical insurers".
const patients = [
  { insurance: "Synthetic Referenced Co" },
  { insurance: "Synthetic Referenced Co" },
  { insurance: "Aetna" },
];

function renderFilters(catalog: { name: string; aliases: string[] }[], onSelectInsurance = vi.fn()) {
  const historical = historicalInsurerNames(catalog, patients);
  const counts: Record<string, number> = {};
  for (const name of [...catalog.map(c => c.name), ...historical]) {
    counts[name] = patients.filter(p => p.insurance === name).length;
  }
  return render(
    <PatientFilters
      insuranceList={catalog.map(c => c.name)}
      historicalInsuranceList={historical}
      insuranceCounts={counts}
      selectedInsurance=""
      onSelectInsurance={onSelectInsurance}
      claimStatusFilters={[]}
      claimStatusCounts={{}}
      selectedClaimsFilter="all"
      onSelectClaimsFilter={() => {}}
    />
  );
}

describe("PatientFilters — historical insurers (P4-P22)", () => {
  const before = [
    { name: "Aetna", aliases: [] },
    { name: "Synthetic Referenced Co", aliases: [] },
  ];
  const after = [{ name: "Aetna", aliases: [] }];

  it("shows no historical group while every recorded insurer is in the catalog", () => {
    renderFilters(before);
    expect(screen.queryByText("Historical insurers")).toBeNull();
    expect(screen.getByRole("button", { name: /Synthetic Referenced Co\s*2/ })).toBeTruthy();
  });

  it("after the catalog refreshes without the deleted entry, it appears only under Historical insurers, still selectable", () => {
    const onSelect = vi.fn();
    renderFilters(before, onSelect);
    cleanup();
    renderFilters(after, onSelect);

    const heading = screen.getByText("Historical insurers");
    const group = heading.parentElement as HTMLElement;
    const button = within(group).getByRole("button", { name: /Synthetic Referenced Co\s*2/ });
    expect(screen.getAllByRole("button", { name: /Synthetic Referenced Co/ })).toHaveLength(1);

    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("Synthetic Referenced Co");
  });

  it("an unreferenced deleted insurer simply disappears", () => {
    renderFilters([...after, { name: "Synthetic Unreferenced Co", aliases: [] }]);
    expect(screen.getByRole("button", { name: /Synthetic Unreferenced Co/ })).toBeTruthy();
    cleanup();
    renderFilters(after);
    expect(screen.queryByRole("button", { name: /Synthetic Unreferenced Co/ })).toBeNull();
  });
});

describe("PatientFilters — insurer search", () => {
  const catalog = ["Aetna", "United Healthcare Medicare Advantage", "Cigna"];
  const counts = { Aetna: 3, "United Healthcare Medicare Advantage": 2, Cigna: 0, "Legacy Free Text Ins": 1 };

  function renderSearch(selectedInsurance = "", onSelectInsurance = vi.fn()) {
    return render(
      <PatientFilters
        insuranceList={catalog}
        historicalInsuranceList={["Legacy Free Text Ins"]}
        insuranceAliases={{ "United Healthcare Medicare Advantage": ["United Healthcare Medicare"] }}
        insuranceCounts={counts}
        selectedInsurance={selectedInsurance}
        onSelectInsurance={onSelectInsurance}
        claimStatusFilters={[]}
        claimStatusCounts={{}}
        selectedClaimsFilter="all"
        onSelectClaimsFilter={() => {}}
      />
    );
  }
  const search = () => screen.getByRole("searchbox", { name: "Search insurance companies" });
  const options = () => screen.queryAllByRole("button", { pressed: false }).concat(screen.queryAllByRole("button", { pressed: true }))
    .filter(b => b.hasAttribute("data-insurance-option")).map(b => b.textContent);

  it("filters by name case-insensitively, keeping counts", () => {
    renderSearch();
    fireEvent.change(search(), { target: { value: "  aet " } });
    expect(options()).toEqual(["Aetna3"]);
  });

  it("matches catalog aliases (pre-rename names)", () => {
    renderSearch();
    fireEvent.change(search(), { target: { value: "healthcare medicare" } });
    expect(options()).toEqual(["United Healthcare Medicare Advantage2"]);
  });

  it("searches historical insurers too, under their own heading", () => {
    renderSearch();
    fireEvent.change(search(), { target: { value: "legacy" } });
    expect(screen.getByText("Historical insurers")).toBeTruthy();
    expect(options()).toEqual(["Legacy Free Text Ins1"]);
  });

  it("never clears or hides the current selection, and never calls onSelectInsurance", () => {
    const onSelect = vi.fn();
    renderSearch("Cigna", onSelect);
    fireEvent.change(search(), { target: { value: "aetna" } });
    expect(options().sort()).toEqual(["Aetna3", "Cigna0"]);
    expect(screen.getByRole("button", { name: /Cigna/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(search(), { key: "Escape" });
    expect((search() as HTMLInputElement).value).toBe("");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a clear empty state that can reset the search", () => {
    renderSearch();
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toContain("No insurers match “zzz”");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(options()).toHaveLength(4);
  });

  it("keyboard: ArrowDown moves from search into the options, arrows move between them, ArrowUp returns", () => {
    const onSelect = vi.fn();
    renderSearch("", onSelect);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Aetna3");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("United Healthcare Medicare Advantage2");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Legacy Free Text Ins1");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search());
  });
});
