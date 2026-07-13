import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ClaimsPlaceholder from "@/pages/ClaimsPlaceholder";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation } from "wouter";
import DashboardLayout from "./components/DashboardLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import { trpc } from "@/lib/trpc";
import { useEffect } from "react";

/** The main dashboard, wrapped in the persistent sidebar shell. */
function DashboardWithLayout() {
  return (
    <DashboardLayout>
      <Dashboard />
    </DashboardLayout>
  );
}

function ClaimsWithLayout() {
  return (
    <DashboardLayout>
      <ClaimsPlaceholder />
    </DashboardLayout>
  );
}

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
      <div className="min-h-screen bg-brand-cream flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-brand-blue border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-brand-blue font-medium text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/" component={() => <ProtectedRoute component={DashboardWithLayout} />} />
      {/*
        "/patients" and "/patients/:id" both render Dashboard -- it reads
        the :id itself (via useRoute) to decide between list and detail
        view. Both must be registered here or Dashboard.tsx's own URL sync
        would navigate to a path this Switch doesn't recognize and fall
        through to the 404 route below.
      */}
      <Route path="/patients" component={() => <ProtectedRoute component={DashboardWithLayout} />} />
      <Route path="/patients/:id" component={() => <ProtectedRoute component={DashboardWithLayout} />} />
      <Route path="/claims" component={() => <ProtectedRoute component={ClaimsWithLayout} />} />
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
