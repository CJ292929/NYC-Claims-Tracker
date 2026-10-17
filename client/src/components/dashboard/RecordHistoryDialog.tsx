import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { History, Loader2 } from "lucide-react";
import { formatTimestamp } from "@/lib/date";

export type HistoryEntityType = "patient" | "visit_record" | "claim_record" | "clinic_user" | "insurer_catalog";

type AuditLogRow = {
  id: string;
  action: string;
  actorDisplay: string | null;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  createdAt: Date | string;
};

function describeChange(beforeData: Record<string, unknown> | null, afterData: Record<string, unknown> | null): string | null {
  const keys = new Set([...Object.keys(beforeData ?? {}), ...Object.keys(afterData ?? {})]);
  if (keys.size === 0) return null;
  return Array.from(keys)
    .map((key) => {
      const before = beforeData?.[key];
      const after = afterData?.[key];
      if (beforeData && afterData) return `${key}: ${String(before ?? "—")} → ${String(after ?? "—")}`;
      if (afterData) return `${key}: ${String(after ?? "—")}`;
      return `${key}: ${String(before ?? "—")}`;
    })
    .join(", ");
}

function useHistoryQuery(entityType: HistoryEntityType, entityId: string, enabled: boolean) {
  const patientHistory = trpc.patients.history.useQuery({ id: entityId }, { enabled: enabled && entityType === "patient" });
  const visitHistory = trpc.visits.historyForPatient.useQuery({ patientId: entityId }, { enabled: enabled && entityType === "visit_record" });
  const claimHistory = trpc.claims.historyForClaim.useQuery({ id: entityId }, { enabled: enabled && entityType === "claim_record" });
  const staffHistory = trpc.staff.history.useQuery({ id: entityId }, { enabled: enabled && entityType === "clinic_user" });
  const insurerHistory = trpc.insurance.history.useQuery({ id: entityId }, { enabled: enabled && entityType === "insurer_catalog" });

  switch (entityType) {
    case "patient": return patientHistory;
    case "visit_record": return visitHistory;
    case "claim_record": return claimHistory;
    case "clinic_user": return staffHistory;
    case "insurer_catalog": return insurerHistory;
  }
}

/** "View History" button + dialog for one record. Fetches
 * entity-scoped audit_logs rows (see server/db.ts listHistoryForEntity) and
 * renders them newest-first, read-only — history is never editable through
 * the app. A record with no history at all (created before tracking
 * existed) shows an explicit "Unknown — recorded before tracking" message
 * rather than an empty list that could be misread as "nothing ever
 * happened to this record". */
/** Controlled dialog only (no trigger of its own) — for callers that need
 * their own trigger element (e.g. a DropdownMenuItem, which can't nest a
 * <button>). See RecordHistoryButton below for the common
 * trigger+dialog-in-one case. */
export function RecordHistoryDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: HistoryEntityType;
  entityId: string;
}) {
  const query = useHistoryQuery(entityType, entityId, open);
  const rows = (query.data ?? []) as AuditLogRow[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record History</DialogTitle>
          <DialogDescription>Who created, edited, or deleted this record, and when. Read-only.</DialogDescription>
        </DialogHeader>

        {query.isLoading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        )}

        {!query.isLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground italic py-6 text-center">
            Unknown — recorded before tracking.
          </p>
        )}

        {!query.isLoading && rows.length > 0 && (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="border rounded-md p-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge variant="outline" className="font-mono text-xs">{row.action}</Badge>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{formatTimestamp(row.createdAt)}</span>
                </div>
                <p className="text-sm">
                  <span className="font-medium">
                    {row.actorDisplay ?? "Unknown — recorded before tracking"}
                  </span>
                </p>
                {describeChange(row.beforeData, row.afterData) && (
                  <p className="text-xs text-muted-foreground mt-1 break-words">
                    {describeChange(row.beforeData, row.afterData)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Trigger button + dialog in one — the common case (e.g. the patient
 * snapshot pane). */
export function RecordHistoryButton({
  entityType,
  entityId,
  label = "View History",
}: {
  entityType: HistoryEntityType;
  entityId: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History className="w-4 h-4 mr-1.5" />
        {label}
      </Button>
      <RecordHistoryDialog open={open} onOpenChange={setOpen} entityType={entityType} entityId={entityId} />
    </>
  );
}

/** Compact "Created by X on <date> · Last updated by Y on <date>" line,
 * derived from the same history rows the dialog above shows — the oldest
 * entry is the creation event, the newest is the most recent edit. Falls
 * back to "Unknown — recorded before tracking" when there's no history at
 * all (pre-dates this feature) rather than guessing an actor. */
export function RecordAttributionLine({
  entityType,
  entityId,
}: {
  entityType: HistoryEntityType;
  entityId: string;
}) {
  const query = useHistoryQuery(entityType, entityId, true);
  const rows = (query.data ?? []) as AuditLogRow[];

  if (query.isLoading) return null;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground italic">Unknown — recorded before tracking</p>;
  }

  const newest = rows[0];
  const oldest = rows[rows.length - 1];

  return (
    <p className="text-xs text-muted-foreground">
      Created by <span className="font-medium">{oldest.actorDisplay ?? "Unknown"}</span> on {formatTimestamp(oldest.createdAt)}
      {newest.id !== oldest.id && (
        <>
          {" · "}Last updated by <span className="font-medium">{newest.actorDisplay ?? "Unknown"}</span> on {formatTimestamp(newest.createdAt)}
        </>
      )}
    </p>
  );
}
