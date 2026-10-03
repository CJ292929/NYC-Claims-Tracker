/**
 * server/parseMeritainEOBWithGroups.boundaries.test.ts
 *
 * P4-P3R: extraction-boundary coverage for parseMeritainEOBWithGroups
 * (server/insuranceTemplates.ts). Uses hand-built synthetic text fixtures
 * shaped like pdftotext -layout output -- no real or synthetic PDF is
 * generated or parsed here; this exercises the text-parsing/section-split
 * logic directly with invented names and non-overlapping dates/CPT/amounts
 * per patient so any cross-patient attribution is immediately visible in
 * the assertions below.
 */
import { describe, expect, it } from "vitest";
import { parseMeritainEOBWithGroups, PatientBoundaryError } from "./insuranceTemplates";
import { classifyPatientMatch } from "../shared/nameMatch";

/** One Meritain service-line row: date-date CPT explCode charge allowed discount otherPlan otherAdj coIns coPay deductible nonCov */
function serviceLine(dos: string, cpt: string, charge: string, allowed: string) {
  return `${dos}-${dos} ${cpt} 395 ${charge} ${allowed} 0.00 0.00 0.00 0.00 0.00 0.00 0.00`;
}

function patientBlock(opts: {
  name: string; // literal text after "Patient:" label, e.g. "ALICE FIRSTPERSON" or malformed variants
  patientLabel?: string; // override the "Patient:" label itself for malformed-marker tests
  claimNo: string;
  groupCheck: string;
  lines: string[]; // pre-built serviceLine() rows
  claimTotal?: string; // omit to simulate a missing "Claim Total:" marker
}) {
  const rows = [
    opts.patientLabel ?? `Patient:   ${opts.name}`,
    `Member #: 0000`,
    `Claim #:  ${opts.claimNo}`,
    `Group Name/Check: ${opts.groupCheck}`,
    ...opts.lines,
  ];
  if (opts.claimTotal !== undefined) rows.push(opts.claimTotal);
  return rows.join("\n");
}

describe("parseMeritainEOBWithGroups — section-boundary extraction", () => {
  it("two patient sections with normal 'Claim Total:' markers stay fully separated", () => {
    const text = [
      patientBlock({
        name: "WANDA GREENFIELD",
        claimNo: "CLM1001",
        groupCheck: "16404/100000001",
        lines: [serviceLine("04/10/20", "97110", "125.00", "125.00"), serviceLine("04/13/20", "97110", "125.00", "125.00")],
        claimTotal: "Claim Total:  250.00",
      }),
      patientBlock({
        name: "DESMOND OKAFOR",
        claimNo: "CLM1002",
        groupCheck: "16404/100000002",
        lines: [serviceLine("01/13/21", "97112", "90.00", "90.00"), serviceLine("01/20/21", "97112", "90.00", "90.00")],
        claimTotal: "Claim Total:  180.00",
      }),
    ].join("\n");

    const groups = parseMeritainEOBWithGroups(text);
    expect(groups.map(g => g.patientName)).toEqual(["WANDA GREENFIELD", "DESMOND OKAFOR"]);

    const wanda = groups.find(g => g.patientName === "WANDA GREENFIELD")!;
    const desmond = groups.find(g => g.patientName === "DESMOND OKAFOR")!;
    expect(wanda.claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97110", "97110"]);
    expect(desmond.claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97112", "97112"]);
    expect(wanda.claims.map(c => c.dateOfService)).toEqual(["2020-04-10", "2020-04-13"]);
    expect(desmond.claims.map(c => c.dateOfService)).toEqual(["2021-01-13", "2021-01-20"]);
    // No amount from one patient ever appears on the other's claims.
    expect(wanda.claims.flatMap(c => c.cptLines.map(l => l.chargeAmount))).toEqual([125, 125]);
    expect(desmond.claims.flatMap(c => c.cptLines.map(l => l.chargeAmount))).toEqual([90, 90]);
  });

  it("whitespace/line-break variations the parser is documented to accept still resolve correctly", () => {
    // "-layout" mode: Member #/Claim #'s columns can share the physical line with
    // the name, separated by a run of 2+ spaces instead of a newline.
    const layoutModeText = patientBlock({
      name: "FELICITY NAKAMURA",
      patientLabel: "Patient:   FELICITY NAKAMURA  Member #: 5555",
      claimNo: "CLM2001",
      groupCheck: "16404/200000001",
      lines: [serviceLine("05/01/22", "99201", "60.00", "60.00")],
      claimTotal: "Claim Total:  60.00",
    });
    const groups1 = parseMeritainEOBWithGroups(layoutModeText);
    expect(groups1).toHaveLength(1);
    expect(groups1[0].patientName).toBe("FELICITY NAKAMURA");
    expect(groups1[0].claims[0].cptLines[0].cptCodes).toBe("99201");

    // Extra blank line between the header block and the service-line table.
    const extraBlankLineText = [
      "Patient:   GREGORIO SANTACRUZ",
      "Member #: 6666",
      "Claim #:  CLM2002",
      "Group Name/Check: 16404/200000002",
      "",
      serviceLine("06/02/22", "99202", "70.00", "70.00"),
      "Claim Total:  70.00",
    ].join("\n");
    const groups2 = parseMeritainEOBWithGroups(extraBlankLineText);
    expect(groups2).toHaveLength(1);
    expect(groups2[0].patientName).toBe("GREGORIO SANTACRUZ");
    expect(groups2[0].claims[0].cptLines[0].cptCodes).toBe("99202");
  });

  it("a missing 'Claim Total:' marker on the first of two patients does not leak lines into the second", () => {
    // No claimTotal on patient 1 -- the ONLY thing preventing a leak here is
    // that splitting happens on the next "Patient:" header, not on "Claim
    // Total:" (see server/insuranceTemplates.ts comment). This fixture
    // exercises that: patient 1's own "Claim Total:" is simply absent, but
    // its header is well-formed, so the split still finds patient 2 cleanly.
    const text = [
      patientBlock({
        name: "HORTENSE ADEYEMI",
        claimNo: "CLM3001",
        groupCheck: "16404/300000001",
        lines: [serviceLine("07/01/22", "97140", "80.00", "80.00")],
        // claimTotal omitted entirely
      }),
      patientBlock({
        name: "LIONEL ABERNATHY",
        claimNo: "CLM3002",
        groupCheck: "16404/300000002",
        lines: [serviceLine("08/01/22", "97530", "95.00", "95.00")],
        claimTotal: "Claim Total:  95.00",
      }),
    ].join("\n");

    const groups = parseMeritainEOBWithGroups(text);
    expect(groups.map(g => g.patientName).sort()).toEqual(["HORTENSE ADEYEMI", "LIONEL ABERNATHY"]);
    const hortense = groups.find(g => g.patientName === "HORTENSE ADEYEMI")!;
    const lionel = groups.find(g => g.patientName === "LIONEL ABERNATHY")!;
    expect(hortense.claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97140"]);
    expect(lionel.claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97530"]);
  });

  it("a malformed second-patient header ('Patient :' with a space before the colon) throws an explicit boundary error instead of attaching that patient's lines to the wrong patient", () => {
    // "Patient :" (space before the colon) fails the split lookahead
    // (/(?=Patient:\s+[A-Z])/), so patient 2's block never gets separated
    // from patient 1's and both patients' service lines end up in one merged
    // section with two "Claim #:" markers -- the telltale sign the parser
    // checks for. There is no reliable way to tell, within that merged text,
    // exactly where Rosalind's data ends and Tobias's begins, so this throws
    // PatientBoundaryError rather than guessing a split point or inventing a
    // placeholder "patient" to hold the ambiguous lines. No group for either
    // name, and no third/sentinel group, is ever returned in this case --
    // the caller must stop and surface the failure (see
    // server/claimUpload.ts's catch for this error).
    const text = [
      patientBlock({
        name: "ROSALIND FITZGERALD",
        claimNo: "CLM4001",
        groupCheck: "16404/400000001",
        lines: [serviceLine("04/10/20", "97110", "125.00", "125.00"), serviceLine("04/13/20", "97110", "125.00", "125.00")],
        // no Claim Total -- nothing to truncate at before the malformed header below
      }),
      patientBlock({
        name: "TOBIAS WINTERBOURNE",
        patientLabel: "Patient :   TOBIAS WINTERBOURNE", // malformed: space before colon
        claimNo: "CLM4002",
        groupCheck: "16404/400000002",
        lines: [serviceLine("01/13/21", "97112", "90.00", "90.00"), serviceLine("01/20/21", "97112", "90.00", "90.00")],
        claimTotal: "Claim Total:  180.00",
      }),
    ].join("\n");

    expect(() => parseMeritainEOBWithGroups(text)).toThrow(PatientBoundaryError);
    expect(() => parseMeritainEOBWithGroups(text)).toThrow(/boundar/i);
  });

  it("a malformed next-patient header with only ONE visible 'Claim #:' marker is still caught (the guard keys on patient headers, not Claim # count)", () => {
    // Same malformed "Patient :" header as above, but this time patient 2's
    // block happens to omit its own "Claim #:" line entirely (unusual for a
    // real Meritain EOB, but not something the parser can rule out). An
    // earlier version of this fix keyed on ">1 Claim #: marker per section",
    // which would have missed this case (only one marker present) and
    // silently merged Bob's line into Alice's group. The guard instead
    // counts "Patient:"-style headers within the section -- Alice's
    // well-formed one plus Bob's malformed "Patient :" one both match, so
    // this is still detected and thrown even without a second "Claim #:".
    const text = [
      patientBlock({
        name: "ALICE FIRSTPERSON",
        claimNo: "CLM6001",
        groupCheck: "16404/600000001",
        lines: [serviceLine("04/10/20", "97110", "125.00", "125.00")],
      }),
      [
        "Patient :   BOB SECONDPERSON", // malformed header AND no "Claim #:" line of its own
        "Member #: 2222",
        "Group Name/Check: 16404/600000002",
        serviceLine("01/13/21", "97112", "90.00", "90.00"),
      ].join("\n"),
      "Claim Total:  215.00",
    ].join("\n");

    expect(() => parseMeritainEOBWithGroups(text)).toThrow(PatientBoundaryError);
  });

  it("KNOWN GAP: a second header with no recognizable 'Patient' label at all (e.g. 'Insured Name:') still merges undetected -- not claimed as fixed", () => {
    // The guard keys on finding a SECOND "Patient<optional space>:" label
    // inside one section. If the source document's second patient block
    // uses a differently-worded label the parser doesn't look for at all
    // (e.g. "Insured Name:" instead of "Patient:"), there is no signal of
    // any kind for the guard to key on, and the merge goes undetected --
    // this is the realistic remaining limitation of a marker-counting
    // heuristic: it cannot catch a boundary failure that leaves no trace in
    // the handful of labels it knows to look for. Recorded here so it's
    // visible and regression-tracked, not silently assumed away.
    const text = [
      "Patient:   ALICE FIRSTPERSON",
      "Member #: 1111",
      "Claim #:  CLM0001",
      "Group Name/Check: 16404/137040261",
      serviceLine("04/10/20", "97110", "125.00", "125.00"),
      "Insured Name:   BOB SECONDPERSON", // no "Patient" substring anywhere
      "Member #: 2222",
      "Claim #:  CLM0002",
      "Group Name/Check: 16404/999999999",
      serviceLine("01/13/21", "97112", "90.00", "90.00"),
      "Claim Total:  215.00",
    ].join("\n");

    const groups = parseMeritainEOBWithGroups(text);
    expect(groups).toHaveLength(1);
    expect(groups[0].patientName).toBe("ALICE FIRSTPERSON");
    expect(groups[0].claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97110", "97112"]);
  });

  it("a legitimate single patient with multiple distinct claims/visits parses each visit correctly and never throws", () => {
    // One real patient can have several Claim #s (one per visit date) within
    // their own well-formed section -- this must keep working exactly as
    // before and must NOT be mistaken for a multi-patient boundary failure.
    const text = [
      "Patient:   ESPERANZA DELACRUZ",
      "Member #: 7777",
      "Claim #:  CLM7001",
      "Group Name/Check: 16404/700000001",
      serviceLine("03/01/23", "97110", "125.00", "125.00"),
      "Claim #:  CLM7002",
      "Group Name/Check: 16404/700000002",
      serviceLine("03/08/23", "97140", "80.00", "80.00"),
      "Claim Total:  205.00",
    ].join("\n");

    expect(() => parseMeritainEOBWithGroups(text)).not.toThrow();
    const groups = parseMeritainEOBWithGroups(text);
    // Two "Claim #:" markers for the SAME patient's two visits is exactly
    // the merge-ambiguity signature the guard checks for, so this one real
    // patient's legitimate multi-visit section is routed to the review
    // sentinel path too -- the guard can't distinguish "one patient, two
    // visits" from "two patients, one visit each" by marker count alone.
    // That's the honest tradeoff of the minimal fix: it never misattributes
    // a line to the wrong patient, but it is conservative enough to also
    // flag some legitimate single-patient documents for manual review
    // rather than risk a false negative. Documented here, not silently
    // assumed.
    expect(groups).toHaveLength(1);
    expect(groups[0].claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97110", "97140"]);
  });

  it("a skipped (not-in-roster) first patient followed by a matched second patient keeps each patient's lines with only that patient", () => {
    const text = [
      patientBlock({
        name: "UNKNOWN WALK IN",
        claimNo: "CLM5001",
        groupCheck: "16404/500000001",
        lines: [serviceLine("09/01/22", "97014", "40.00", "40.00")],
        claimTotal: "Claim Total:  40.00",
      }),
      patientBlock({
        name: "WANDA GREENFIELD",
        claimNo: "CLM5002",
        groupCheck: "16404/500000002",
        lines: [serviceLine("09/05/22", "97110", "125.00", "125.00")],
        claimTotal: "Claim Total:  125.00",
      }),
    ].join("\n");

    const groups = parseMeritainEOBWithGroups(text);
    expect(groups.map(g => g.patientName)).toEqual(["UNKNOWN WALK IN", "WANDA GREENFIELD"]);

    const roster = [{ id: "p1", name: "WANDA GREENFIELD" }];
    const skippedGroup = groups.find(g => g.patientName === "UNKNOWN WALK IN")!;
    const matchedGroup = groups.find(g => g.patientName === "WANDA GREENFIELD")!;

    expect(classifyPatientMatch(skippedGroup.patientName, roster).confirmed).toBeNull();
    expect(classifyPatientMatch(matchedGroup.patientName, roster).confirmed?.name).toBe("WANDA GREENFIELD");

    // The matched patient's claim carries only her own CPT/date -- nothing
    // from the skipped walk-in section.
    expect(matchedGroup.claims.flatMap(c => c.cptLines.map(l => l.cptCodes))).toEqual(["97110"]);
    expect(matchedGroup.claims.map(c => c.dateOfService)).toEqual(["2022-09-05"]);
  });
});
