import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { canManageStaff } from "@/lib/authGate";
import { navSectionToRoute } from "@/lib/navSection";
import type { NavSection } from "@/components/dashboard/DashboardSidebar";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { formatTimestamp } from "@/lib/date";

type EntityType = "patient" | "visit_record" | "claim_record" | "insurer_catalog" | "clinic_user";

const ENTITY_LABELS: Record<EntityType, string> = {
  patient: "Patient",
  visit_record: "Visit / Authorization",
  claim_record: "Claim",
  insurer_catalog: "Insurer",
  clinic_user: "Staff Account",
};

const PAGE_SIZE = 25;

function describeChange(beforeData: Record<string, unknown> | null, afterData: Record<string, unknown> | null): string | null {
  if (!afterData && !beforeData) return null;
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
    .join("; ");
}

export default function ActivityLog() {
  const [, navigate] = useLocation();
  const { data: authUser } = trpc.auth.me.useQuery();
  const logoutMutation = trpc.auth.logout.useMutation();

  const handleNavigate = (section: NavSection) => {
    const route = navSectionToRoute(section);
    if (route) navigate(route);
  };

  const handleSignOut = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => { window.location.href = "/login"; },
      onError: () => { window.location.href = "/login"; },
    });
  };

  const staffQuery = trpc.staff.list.useQuery();
  const staff = staffQuery.data ?? [];

  const [actorId, setActorId] = useState<string>("all");
  const [entityType, setEntityType] = useState<"all" | EntityType>("all");
  const [action, setAction] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  const query = trpc.activityLog.list.useQuery({
    actorId: actorId === "all" ? undefined : actorId,
    entityType: entityType === "all" ? undefined : entityType,
    action: action === "all" ? undefined : action,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const knownActions = Array.from(new Set(rows.map((r) => r.action))).sort();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetFilters = () => {
    setActorId("all"); setEntityType("all"); setAction("all");
    setDateFrom(""); setDateTo(""); setPage(0);
  };

  return (
    <DashboardShell
      activeSection="activity-log"
      onNavigate={handleNavigate}
      onSignOut={handleSignOut}
      signingOut={logoutMutation.isPending}
      canManageStaff={canManageStaff(authUser)}
      topbarTitle="Activity Log"
      topbarSubtitle="Who created, edited, imported, or deleted records, and when."
    >
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6 space-y-4">
        <Card>
          <CardContent className="p-4 flex flex-col sm:flex-row flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1 min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground">User</label>
              <Select value={actorId} onValueChange={(v) => { setActorId(v); setPage(0); }}>
                <SelectTrigger><SelectValue placeholder="All users" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name || s.username}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground">Record type</label>
              <Select value={entityType} onValueChange={(v) => { setEntityType(v as "all" | EntityType); setPage(0); }}>
                <SelectTrigger><SelectValue placeholder="All types" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {Object.entries(ENTITY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground">Action</label>
              <Select value={action} onValueChange={(v) => { setAction(v); setPage(0); }}>
                <SelectTrigger><SelectValue placeholder="All actions" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {knownActions.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>

            <Button variant="outline" onClick={resetFilters}>Reset filters</Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>What changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.isLoading && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!query.isLoading && rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                      No activity matches these filters.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-sm">{formatTimestamp(row.createdAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {row.actorDisplay ?? (
                        <span className="text-muted-foreground italic">Unknown — recorded before tracking</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">{row.action}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.entityType ? ENTITY_LABELS[row.entityType as EntityType] ?? row.entityType : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[420px] truncate" title={describeChange(row.beforeData, row.afterData) ?? ""}>
                      {describeChange(row.beforeData, row.afterData) ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total === 0 ? "No results" : `Page ${page + 1} of ${totalPages} — ${total} total events`}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
