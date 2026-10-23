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
