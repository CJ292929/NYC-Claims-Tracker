import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import ChangePassword from "./pages/ChangePassword";
import StaffManagement from "./pages/StaffManagement";
import ActivityLog from "./pages/ActivityLog";
import { trpc } from "@/lib/trpc";
import { canManageStaff, isForcedPasswordChange } from "@/lib/authGate";
import { useEffect } from "react";

function AuthLoadingScreen() {
  return (
    <div className="min-h-screen bg-[#FAF5EE] flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-4 border-[#1E3A5F] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-[#1E3A5F] font-medium text-sm">Loading…</p>
      </div>
    </div>
  );
}

/** Wraps a component and redirects to /login if the user is not authenticated.
 * Clinic staff with mustChangePassword=true are redirected to /change-password
 * instead of reaching normal dashboard functionality — owner OAuth sessions
 * never carry mustChangePassword, so they are never affected by this gate. */
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const [, navigate] = useLocation();
  const { data: user, isLoading } = trpc.auth.me.useQuery();
  const forcedPasswordChange = isForcedPasswordChange(user);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate("/login");
    } else if (forcedPasswordChange) {
      navigate("/change-password");
    }
  }, [isLoading, user, forcedPasswordChange, navigate]);

  if (isLoading) return <AuthLoadingScreen />;
  if (!user || forcedPasswordChange) return null;

  return <Component />;
}

/** /change-password: reachable by any authenticated clinic staff member
 * (forced when mustChangePassword=true, optional otherwise). Owner OAuth
 * sessions have no password to change, so they're redirected to /dashboard. */
function ChangePasswordRoute() {
  const [, navigate] = useLocation();
  const { data: user, isLoading } = trpc.auth.me.useQuery();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate("/login");
    } else if (user.authType !== "clinic") {
      navigate("/dashboard");
    }
  }, [isLoading, user, navigate]);

  if (isLoading || !user || user.authType !== "clinic") return <AuthLoadingScreen />;

  return <ChangePassword mustChangePassword={user.mustChangePassword} />;
}

/** /staff: owner OAuth admins and clinic admins only (mirrors the server's
 * adminOrOwnerProcedure gate). Clinic staff are redirected to /dashboard —
 * this is UX only, the real enforcement is server-side on every staff.*
 * endpoint, so a direct API call from a staff session is still rejected
 * even if this client-side check were somehow bypassed. */
function StaffManagementRoute() {
  const [, navigate] = useLocation();
  const { data: user, isLoading } = trpc.auth.me.useQuery();
  const forcedPasswordChange = isForcedPasswordChange(user);
  const allowed = canManageStaff(user);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate("/login");
    } else if (forcedPasswordChange) {
      navigate("/change-password");
    } else if (!allowed) {
      navigate("/dashboard");
    }
  }, [isLoading, user, forcedPasswordChange, allowed, navigate]);

  if (isLoading) return <AuthLoadingScreen />;
  if (!user || forcedPasswordChange || !allowed) return null;

  return <StaffManagement />;
}

/** /activity-log: owner OAuth admins and clinic admins only — same gate as
 * /staff (mirrors the server's activityLog.list adminOrOwnerProcedure). */
function ActivityLogRoute() {
  const [, navigate] = useLocation();
  const { data: user, isLoading } = trpc.auth.me.useQuery();
  const forcedPasswordChange = isForcedPasswordChange(user);
  const allowed = canManageStaff(user);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate("/login");
    } else if (forcedPasswordChange) {
      navigate("/change-password");
    } else if (!allowed) {
      navigate("/dashboard");
    }
  }, [isLoading, user, forcedPasswordChange, allowed, navigate]);

  if (isLoading) return <AuthLoadingScreen />;
  if (!user || forcedPasswordChange || !allowed) return null;

  return <ActivityLog />;
}

/** Every path backed by the same Dashboard instance. Extracted so tests can
 * verify route/component wiring without rendering the app. */
export const DASHBOARD_ROUTE_PATHS = [
  "/dashboard",
  "/patients",
  "/patients/records",
  "/patients/discharged",
  "/authorizations",
  "/authorizations/attention",
  "/authorizations/records",
  "/visits",
  "/claims",
] as const;

/** Stable component reference shared by every Dashboard-backed route, so cross-route
 * navigation does not unmount/remount the Dashboard subtree. */
const ProtectedDashboard = () => <ProtectedRoute component={Dashboard} />;

/** Matches every path in DASHBOARD_ROUTE_PATHS. Used as a *single* Route's `path`
 * (instead of mapping DASHBOARD_ROUTE_PATHS to one <Route> per path) so the
 * Dashboard-backed route is one static JSX element, not an array element with a
 * per-path `key`. wouter's <Switch> clones whichever <Route> matches while
 * preserving its original `key` — with a `key` derived from the path, navigating
 * between two Dashboard-backed paths (e.g. /patients/records -> /visits) changes
 * the key React sees on Switch's rendered output, which is enough on its own to
 * make React unmount/remount the subtree even though `component` never changes.
 * A single keyless element has nothing to change between routes, so identity
 * (and all of Dashboard's local state) survives navigation. */
export const DASHBOARD_ROUTE_PATTERN = new RegExp(
  `^(?:${DASHBOARD_ROUTE_PATHS.map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`
);

export function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/change-password" component={ChangePasswordRoute} />
      <Route path="/staff" component={StaffManagementRoute} />
      <Route path="/activity-log" component={ActivityLogRoute} />
      <Route path="/" component={() => <Redirect to="/dashboard" />} />
      <Route path={DASHBOARD_ROUTE_PATTERN} component={ProtectedDashboard} />
      <Route path="/404" component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
