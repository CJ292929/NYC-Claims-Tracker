import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import { trpc } from "@/lib/trpc";
import { useEffect } from "react";

/** Wraps a component and redirects to /login if the user is not authenticated. */
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const [, navigate] = useLocation();
  const { data: user, isLoading } = trpc.auth.me.useQuery();

  useEffect(() => {
    if (!isLoading && !user) {
      navigate("/login");
    }
  }, [isLoading, user, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FAF5EE] flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-[#1E3A5F] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-[#1E3A5F] font-medium text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return <Component />;
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

export function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/" component={() => <Redirect to="/dashboard" />} />
      {DASHBOARD_ROUTE_PATHS.map((path) => (
        <Route key={path} path={path} component={ProtectedDashboard} />
      ))}
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
