import { describe, expect, it } from "vitest";
import { buildClaimCsvTemplate } from "./claimCsvTemplates";
import { buildPatientCsvTemplate, groupPatientRows, parsePatientCsv, patientNameKey, PATIENT_CSV_MAX_ROWS } from "./patientCsvImport";

const HEADER = "Patient Name,Insurance,Authorized Sessions,Authorization Date,Date of Service,Session Number,Sessions Remaining,New Authorization?,Date Authorization Submitted";

describe("patient CSV template", () => {
  it("round-trips: the downloaded template parses with no errors", () => {
    const parsed = parsePatientCsv(buildPatientCsvTemplate());
    expect(parsed.fileError).toBeNull();
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows.every(r => r.errors.length === 0)).toBe(true);
    const groups = groupPatientRows(parsed.rows);
    expect(groups.map(g => [g.name, g.visits.length])).toEqual([["SAMPLE, PATIENT ONE", 2], ["SAMPLE, PATIENT TWO", 1]]);
  });

  it("accepts the P4-P26 header aliases", () => {
    const parsed = parsePatientCsv("Name,Insurance Company,Total Authorized,Date ASH Submitted\nDOE JANE,,8,2026-01-02\n");
    expect(parsed.fileError).toBeNull();
    expect(parsed.rows[0]).toMatchObject({ name: "DOE JANE", visit: { sessionsAuthorized: 8, sessionsRemaining: 8, dateAuthSubmitted: "2026-01-02" } });
  });
});

describe("wrong files are refused", () => {
  it.each(["cms1500", "eob"] as const)("refuses the %s claims template", kind => {
    expect(parsePatientCsv(buildClaimCsvTemplate(kind)).fileError?.code).toBe("claims_template");
  });

  it("refuses the CMS1500 invoice export", () => {
    const r = parsePatientCsv("Service Date(s),Patient,Invoice #,Description,Total,Balance\n2026-01-01,DOE JANE,1,97110,10,0\n");
    expect(r.fileError?.code).toBe("claims_template");
  });

  it.each(["Insurance Paid", "Patient Due", "Billed Charge", "Amount", "CPT Code", "Claim Status", "Copay", "Total"])(
    "refuses a financial or claims column: %s",
    col => {
      const r = parsePatientCsv(`Patient Name,${col}\nDOE JANE,10\n`);
      expect(r.fileError?.code).toBe("financial_columns");
      expect(r.rows).toEqual([]);
    }
  );

  it("refuses a file without a name column, an empty file and an oversized file", () => {
    expect(parsePatientCsv("Insurance\nAetna\n").fileError?.code).toBe("missing_name_column");
    expect(parsePatientCsv("").fileError?.code).toBe("empty");
    expect(parsePatientCsv(`${HEADER}\n`).fileError?.code).toBe("empty");
    const many = [HEADER, ...Array.from({ length: PATIENT_CSV_MAX_ROWS + 1 }, (_, i) => `P${i}`)].join("\n");
    expect(parsePatientCsv(many).fileError?.code).toBe("too_many_rows");
  });
});

describe("row validation", () => {
  const row = (cells: string) => parsePatientCsv(`${HEADER}\n${cells}\n`).rows[0];

  it("reports bad numbers and dates instead of guessing", () => {
    const r = row(`DOE JANE,,twelve,2026-02-30,13/01/2026,0,abc,MAYBE,`);
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Authorized Sessions"),
      expect.stringContaining("Authorization Date"),
      expect.stringContaining("Date of Service"),
      expect.stringContaining("Session Number"),
      expect.stringContaining("Sessions Remaining"),
      expect.stringContaining("New Authorization?"),
    ]));
  });

  it("requires a name and refuses formula-like names", () => {
    expect(row(`,,12`).errors).toContain("Patient Name is required.");
    expect(row(`=HYPERLINK("x"),,12`).errors[0]).toMatch(/cannot start/);
  });

  it("refuses remaining > authorized", () => {
    expect(row(`DOE JANE,,5,,,1,6`).errors[0]).toMatch(/more than Authorized/);
  });

  it("a name-only row creates a patient without a session", () => {
    expect(row(`DOE JANE`).visit).toBeNull();
  });
});

describe("grouping and duplicates in one file", () => {
  it("merges name variants into one patient and drops exact repeat lines", () => {
    const parsed = parsePatientCsv([
      HEADER,
      "\"DOE, JANE\",,12,2026-01-01,2026-01-05,1,11,NO,",
      "Jane Doe,,12,,2026-01-07,2,10,NO,",
      "jane  doe,,12,,2026-01-07,2,10,NO,",
    ].join("\n"));
    const groups = groupPatientRows(parsed.rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "DOE, JANE", authDate: "2026-01-01", lines: [2, 3, 4], duplicateLines: [4], status: "new" });
    expect(groups[0].visits).toHaveLength(2);
  });

  it("conflicting insurance or authorization date makes the patient invalid", () => {
    const parsed = parsePatientCsv([HEADER, "DOE JANE,Aetna,12,2026-01-01", "DOE JANE,Cigna,12,2026-02-01"].join("\n"));
    const [g] = groupPatientRows(parsed.rows);
    expect(g.status).toBe("invalid");
    expect(g.errors).toHaveLength(2);
  });

  it("one bad line makes the whole patient invalid", () => {
    const parsed = parsePatientCsv([HEADER, "DOE JANE,,12", "DOE JANE,,x"].join("\n"));
    expect(groupPatientRows(parsed.rows)[0].status).toBe("invalid");
  });

  it("name key matches the database rule", () => {
    expect(patientNameKey("O'Brien, James")).toBe(patientNameKey("james obrien"));
    expect(patientNameKey("GARCIA-LOPEZ, MARIA")).toBe("GARCIA LOPEZ MARIA");
  });
});
