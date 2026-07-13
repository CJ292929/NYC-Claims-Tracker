// Route path constants for the NYC Home Rehab Claims Dashboard.
//
// Routing is handled by `wouter`, wired in client/src/App.tsx's
// <Switch>/<Route> setup (browser History API, no separate provider
// component). This project intentionally does not use react-router-dom:
// adding a second routing library alongside an already-wired one would
// mean two routers competing for the same browser history, for no
// functional benefit.
//
// These constants aren't wired into App.tsx/Dashboard.tsx/DashboardLayout.tsx
// yet -- those files currently use the path strings directly. Swapping them
// in is a small, optional consistency pass for a future session, not done
// here to avoid re-touching already-committed, tested routing logic.

export const ROUTES = {
  login: "/login",
  dashboardRoot: "/",
  patientsList: "/patients",
  patientDetail: (id: string) => `/patients/${id}`, // opaque patient id, not a name, per the audit's HIPAA note
  claims: "/claims",
  notFound: "/404",
  // Future routes, not yet built:
  // reports: '/reports',
  // bulkUpload: '/bulk-upload',
  // settings: '/settings',
  // profile: '/profile',
} as const;
