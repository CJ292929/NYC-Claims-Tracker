import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { canManageStaff } from "@/lib/authGate";
import { navSectionToRoute } from "@/lib/navSection";
import type { NavSection } from "@/components/dashboard/DashboardSidebar";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  Archive,
  History,
  KeyRound,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { formatTimestamp } from "@/lib/date";
import { RecordHistoryDialog } from "@/components/dashboard/RecordHistoryDialog";
import { validateCreateStaffForm, validateResetStaffPasswordForm } from "@/lib/staffValidation";
import { MIN_CLINIC_PASSWORD_LENGTH } from "@shared/const";

type StaffRole = "admin" | "staff";
type StaffStatus = "active" | "archived";

type StaffRow = {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
  department: string | null;
  role: StaffRole;
  status: StaffStatus;
  mustChangePassword: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastLoginAt: Date | string | null;
  archivedAt: Date | string | null;
};

const ROLE_BADGE: Record<StaffRole, string> = {
  admin: "bg-blue-100 text-blue-800 border-transparent",
  staff: "bg-gray-100 text-gray-700 border-transparent",
};

const STATUS_BADGE: Record<StaffStatus, string> = {
  active: "bg-green-100 text-green-800 border-transparent",
  archived: "bg-gray-200 text-gray-600 border-transparent",
};

/** Owner/admin-only page — StaffManagementRoute (App.tsx) already redirects
 * anyone else away, and every staff.* endpoint enforces the same gate
 * server-side, so this component can assume its caller is authorized. */
export default function StaffManagement() {
  const [, navigate] = useLocation();
  const { data: authUser } = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const logoutMutation = trpc.auth.logout.useMutation();
  const handleSignOut = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => { window.location.href = "/login"; },
      onError: () => { window.location.href = "/login"; },
    });
  };

  // Bulk Upload has no route of its own (see navSection.ts) — land on the
  // dashboard rather than fabricating a page for it.
  const handleNavigate = (section: NavSection) => {
    if (section === "bulk-upload") {
      navigate("/dashboard");
      return;
    }
    const route = navSectionToRoute(section);
    if (route) navigate(route);
  };

  const selfClinicUserId = authUser?.authType === "clinic" ? authUser.clinicUserId : null;

  const staffQuery = trpc.staff.list.useQuery();
  const staff = (staffQuery.data ?? []) as StaffRow[];

  const invalidateStaff = () => utils.staff.list.invalidate();

  // ── Filters ──────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | StaffRole>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | StaffStatus>("all");

  const filteredStaff = useMemo(() => {
    const q = search.trim().toLowerCase();
    return staff.filter((s) => {
      if (roleFilter !== "all" && s.role !== roleFilter) return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (q) {
        const haystack = `${s.name ?? ""} ${s.username} ${s.email ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [staff, search, roleFilter, statusFilter]);

  const hasFilters = search.trim() !== "" || roleFilter !== "all" || statusFilter !== "all";

  // ── Add Staff dialog ─────────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addDepartment, setAddDepartment] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addRole, setAddRole] = useState<StaffRole>("staff");
  const [addStatus, setAddStatus] = useState<StaffStatus>("active");
  const [addPassword, setAddPassword] = useState("");
  const [addConfirmPassword, setAddConfirmPassword] = useState("");
  const [addError, setAddError] = useState("");

  const resetAddForm = () => {
    setAddName(""); setAddEmail(""); setAddDepartment(""); setAddUsername("");
    setAddRole("staff"); setAddStatus("active");
    setAddPassword(""); setAddConfirmPassword(""); setAddError("");
  };

  const createMutation = trpc.staff.create.useMutation({
    onSuccess: () => {
      toast.success("Staff account created.");
      invalidateStaff();
      setAddOpen(false);
      resetAddForm();
    },
    onError: (err) => setAddError(err.message || "Could not create staff account."),
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAddError("");
    const validationError = validateCreateStaffForm({
      name: addName,
      username: addUsername,
      password: addPassword,
      confirmPassword: addConfirmPassword,
    });
    if (validationError) {
      setAddError(validationError);
      return;
    }
    createMutation.mutate({
      name: addName.trim(),
      email: addEmail.trim() || undefined,
      department: addDepartment.trim() || undefined,
      username: addUsername.trim(),
      role: addRole,
      status: addStatus,
      password: addPassword,
      confirmPassword: addConfirmPassword,
    });
  };

  // ── Edit Profile dialog ──────────────────────────────────────────────────
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editDepartment, setEditDepartment] = useState("");
  const [editRole, setEditRole] = useState<StaffRole>("staff");
  const [editError, setEditError] = useState("");

  const openEdit = (row: StaffRow) => {
    setEditing(row);
    setEditName(row.name ?? "");
    setEditEmail(row.email ?? "");
    setEditDepartment(row.department ?? "");
    setEditRole(row.role);
    setEditError("");
  };

  const updateMutation = trpc.staff.update.useMutation({
    onSuccess: () => {
      toast.success("Staff profile updated.");
      invalidateStaff();
      setEditing(null);
    },
    onError: (err) => setEditError(err.message || "Could not update staff account."),
  });

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setEditError("");
    if (!editing) return;
    if (!editName.trim()) {
      setEditError("Full name is required.");
      return;
    }
    updateMutation.mutate({
      id: editing.id,
      name: editName.trim(),
      email: editEmail.trim() || undefined,
      department: editDepartment.trim() || undefined,
      role: editRole,
    });
  };

  // ── Reset Login dialog ───────────────────────────────────────────────────
  const [resetting, setResetting] = useState<StaffRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetError, setResetError] = useState("");

  const openReset = (row: StaffRow) => {
    setResetting(row);
    setResetPassword("");
    setResetConfirmPassword("");
    setResetError("");
  };

  const resetPasswordMutation = trpc.staff.resetPassword.useMutation({
    onSuccess: () => {
      toast.success("Login reset. The new temporary password takes effect immediately.");
      invalidateStaff();
      setResetting(null);
    },
    onError: (err) => setResetError(err.message || "Could not reset login."),
  });

  const handleResetSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setResetError("");
    if (!resetting) return;
    const validationError = validateResetStaffPasswordForm({
      password: resetPassword,
      confirmPassword: resetConfirmPassword,
    });
    if (validationError) {
      setResetError(validationError);
      return;
    }
    resetPasswordMutation.mutate({
      id: resetting.id,
      password: resetPassword,
      confirmPassword: resetConfirmPassword,
    });
  };

  // ── Archive / Reactivate ─────────────────────────────────────────────────
  const [archiving, setArchiving] = useState<StaffRow | null>(null);
  const [reactivating, setReactivating] = useState<StaffRow | null>(null);
  const [historyFor, setHistoryFor] = useState<StaffRow | null>(null);

  const archiveMutation = trpc.staff.archive.useMutation({
    onSuccess: () => {
      toast.success("Staff account archived.");
      invalidateStaff();
      setArchiving(null);
    },
    onError: (err) => {
      toast.error(err.message || "Could not archive staff account.");
      setArchiving(null);
    },
  });

  const reactivateMutation = trpc.staff.reactivate.useMutation({
    onSuccess: () => {
      toast.success("Staff account reactivated.");
      invalidateStaff();
      setReactivating(null);
    },
    onError: (err) => {
      toast.error(err.message || "Could not reactivate staff account.");
      setReactivating(null);
    },
  });

  const isSelf = (row: StaffRow) => selfClinicUserId != null && row.id === selfClinicUserId;

  return (
    <DashboardShell
      activeSection="staff"
      onNavigate={handleNavigate}
      onSignOut={handleSignOut}
      signingOut={logoutMutation.isPending}
      canManageStaff={canManageStaff(authUser)}
      topbarTitle="Staff Management"
      topbarSubtitle="Manage staff accounts and access."
      topbarActions={
        <Button
          onClick={() => setAddOpen(true)}
          className="bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Add Staff
        </Button>
      }
    >
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6 space-y-4">
        {/* ── Filters ── */}
        <Card>
          <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search name, username, or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as "all" | StaffRole)}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Roles</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="staff">Staff</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | StaffStatus)}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* ── Content ── */}
        {staffQuery.isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading staff accounts…
          </div>
        ) : staffQuery.isError ? (
          <div className="flex items-center justify-center gap-2 py-20 text-red-700">
            <AlertCircle className="w-5 h-5" />
            Unable to load staff accounts.
          </div>
        ) : staff.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground text-sm">
            No staff accounts found.
          </div>
        ) : filteredStaff.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground text-sm">
            No staff match the selected filters.
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <Card className="hidden md:block overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Username</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Login</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStaff.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{row.username}</TableCell>
                      <TableCell className="text-muted-foreground">{row.email || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{row.department || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={ROLE_BADGE[row.role]}>
                          {row.role === "admin" ? "Admin" : "Staff"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_BADGE[row.status]}>
                          {row.status === "active" ? "Active" : "Archived"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.lastLoginAt ? formatTimestamp(row.lastLoginAt) : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <StaffRowActions
                          row={row}
                          isSelf={isSelf(row)}
                          onEdit={() => openEdit(row)}
                          onReset={() => openReset(row)}
                          onArchive={() => setArchiving(row)}
                          onReactivate={() => setReactivating(row)}
                          onViewHistory={() => setHistoryFor(row)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {filteredStaff.map((row) => (
                <Card key={row.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{row.name || row.username}</p>
                        <p className="text-sm text-muted-foreground truncate">@{row.username}</p>
                      </div>
                      <StaffRowActions
                        row={row}
                        isSelf={isSelf(row)}
                        onEdit={() => openEdit(row)}
                        onReset={() => openReset(row)}
                        onArchive={() => setArchiving(row)}
                        onReactivate={() => setReactivating(row)}
                        onViewHistory={() => setHistoryFor(row)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className={ROLE_BADGE[row.role]}>
                        {row.role === "admin" ? "Admin" : "Staff"}
                      </Badge>
                      <Badge variant="outline" className={STATUS_BADGE[row.status]}>
                        {row.status === "active" ? "Active" : "Archived"}
                      </Badge>
                    </div>
                    <Separator />
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                      <dt className="text-muted-foreground">Email</dt>
                      <dd className="text-right truncate">{row.email || "—"}</dd>
                      <dt className="text-muted-foreground">Department</dt>
                      <dd className="text-right truncate">{row.department || "—"}</dd>
                      <dt className="text-muted-foreground">Last Login</dt>
                      <dd className="text-right truncate">
                        {row.lastLoginAt ? formatTimestamp(row.lastLoginAt) : "Never"}
                      </dd>
                    </dl>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
        {hasFilters && staff.length > 0 && filteredStaff.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {filteredStaff.length} of {staff.length} staff accounts.
          </p>
        )}
      </div>

      {/* ── Add Staff dialog ── */}
      <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) resetAddForm(); }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Staff</DialogTitle>
            <DialogDescription>Create a new staff account with a temporary password.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateSubmit} className="space-y-4">
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Personal</h4>
              <div className="space-y-1.5">
                <Label htmlFor="addName">Full Name *</Label>
                <Input id="addName" value={addName} onChange={(e) => setAddName(e.target.value)} disabled={createMutation.isPending} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="addEmail">Email</Label>
                  <Input id="addEmail" type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} disabled={createMutation.isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="addDepartment">Department</Label>
                  <Input id="addDepartment" value={addDepartment} onChange={(e) => setAddDepartment(e.target.value)} disabled={createMutation.isPending} />
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Account</h4>
              <div className="space-y-1.5">
                <Label htmlFor="addUsername">Username *</Label>
                <Input id="addUsername" value={addUsername} onChange={(e) => setAddUsername(e.target.value)} disabled={createMutation.isPending} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Role *</Label>
                  <Select value={addRole} onValueChange={(v) => setAddRole(v as StaffRole)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="staff">Staff</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select value={addStatus} onValueChange={(v) => setAddStatus(v as StaffStatus)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Login</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="addPassword">Temporary Password *</Label>
                  <Input
                    id="addPassword"
                    type="password"
                    autoComplete="new-password"
                    placeholder={`At least ${MIN_CLINIC_PASSWORD_LENGTH} characters`}
                    value={addPassword}
                    onChange={(e) => setAddPassword(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="addConfirmPassword">Confirm Temporary Password *</Label>
                  <Input
                    id="addConfirmPassword"
                    type="password"
                    autoComplete="new-password"
                    value={addConfirmPassword}
                    onChange={(e) => setAddConfirmPassword(e.target.value)}
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The staff member must set their own password the first time they sign in.
              </p>
            </div>

            {addError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{addError}</span>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={createMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending} className="bg-brand-blue hover:bg-brand-blue-dark text-white">
                {createMutation.isPending ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Creating…</>) : "Create Staff Account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Edit Profile dialog ── */}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Profile</DialogTitle>
            <DialogDescription>
              Update {editing?.name || editing?.username}&apos;s profile details.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="editName">Full Name *</Label>
              <Input id="editName" value={editName} onChange={(e) => setEditName(e.target.value)} disabled={updateMutation.isPending} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="editEmail">Email</Label>
                <Input id="editEmail" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} disabled={updateMutation.isPending} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="editDepartment">Department</Label>
                <Input id="editDepartment" value={editDepartment} onChange={(e) => setEditDepartment(e.target.value)} disabled={updateMutation.isPending} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select
                value={editRole}
                onValueChange={(v) => setEditRole(v as StaffRole)}
                disabled={updateMutation.isPending || (editing ? isSelf(editing) : false)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">Staff</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              {editing && isSelf(editing) && (
                <p className="text-xs text-muted-foreground">You cannot change your own role.</p>
              )}
            </div>

            {editError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{editError}</span>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={updateMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending} className="bg-brand-blue hover:bg-brand-blue-dark text-white">
                {updateMutation.isPending ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving…</>) : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Reset Login dialog ── */}
      <Dialog open={resetting !== null} onOpenChange={(open) => { if (!open) setResetting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Login</DialogTitle>
            <DialogDescription>
              Set a new temporary password for {resetting?.name || resetting?.username}. This immediately signs them
              out everywhere, and they must choose their own password on next sign-in.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleResetSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="resetPassword">New Temporary Password *</Label>
              <Input
                id="resetPassword"
                type="password"
                autoComplete="new-password"
                placeholder={`At least ${MIN_CLINIC_PASSWORD_LENGTH} characters`}
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                disabled={resetPasswordMutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resetConfirmPassword">Confirm Temporary Password *</Label>
              <Input
                id="resetConfirmPassword"
                type="password"
                autoComplete="new-password"
                value={resetConfirmPassword}
                onChange={(e) => setResetConfirmPassword(e.target.value)}
                disabled={resetPasswordMutation.isPending}
              />
            </div>

            {resetError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{resetError}</span>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => setResetting(null)} disabled={resetPasswordMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={resetPasswordMutation.isPending} className="bg-brand-blue hover:bg-brand-blue-dark text-white">
                {resetPasswordMutation.isPending ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Resetting…</>) : "Reset Login"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Archive confirm ── */}
      <AlertDialog open={archiving !== null} onOpenChange={(open) => { if (!open) setArchiving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive staff account?</AlertDialogTitle>
            <AlertDialogDescription>
              {archiving?.name || archiving?.username} will immediately lose access — any active sessions are signed
              out and sign-in is blocked. Their record is kept, not deleted, and can be reactivated later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() => archiving && archiveMutation.mutate({ id: archiving.id })}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {archiveMutation.isPending ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Archiving…</>) : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reactivate confirm ── */}
      <AlertDialog open={reactivating !== null} onOpenChange={(open) => { if (!open) setReactivating(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reactivate staff account?</AlertDialogTitle>
            <AlertDialogDescription>
              {reactivating?.name || reactivating?.username} will be able to sign in again with their existing
              password. Use Reset Login separately if that password is no longer known.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reactivateMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reactivateMutation.isPending}
              onClick={() => reactivating && reactivateMutation.mutate({ id: reactivating.id })}
              className="bg-brand-blue hover:bg-brand-blue-dark text-white"
            >
              {reactivateMutation.isPending ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Reactivating…</>) : "Reactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {historyFor && (
        <RecordHistoryDialog
          open={historyFor !== null}
          onOpenChange={(open) => { if (!open) setHistoryFor(null); }}
          entityType="clinic_user"
          entityId={historyFor.id}
        />
      )}
    </DashboardShell>
  );
}

function StaffRowActions({
  row,
  isSelf,
  onEdit,
  onReset,
  onArchive,
  onReactivate,
  onViewHistory,
}: {
  row: StaffRow;
  isSelf: boolean;
  onEdit: () => void;
  onReset: () => void;
  onArchive: () => void;
  onReactivate: () => void;
  onViewHistory: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${row.name || row.username}`}>
          <MoreVertical className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="w-4 h-4 mr-2" />
          Edit Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onReset}>
          <KeyRound className="w-4 h-4 mr-2" />
          Reset Login
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onViewHistory}>
          <History className="w-4 h-4 mr-2" />
          View History
        </DropdownMenuItem>
        {row.status === "active" ? (
          <DropdownMenuItem
            onClick={onArchive}
            disabled={isSelf}
            className="text-red-600 focus:text-red-600"
          >
            <Archive className="w-4 h-4 mr-2" />
            Archive
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={onReactivate}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Reactivate
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
