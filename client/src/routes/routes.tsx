// Route path constants for the NYC Home Rehab Claims Dashboard.
// Session 1: skeleton only -- no new routes are wired up yet.
// Session 3 will add <Route> entries to App.tsx's <Switch> using these paths.
//
// Routing is handled by `wouter`, already installed and wired in
// client/src/App.tsx (a <Switch>/<Route> setup using the browser History
// API by default -- no separate provider/wrapper component needed). This
// project intentionally does not use react-router-dom: adding a second
// routing library alongside an already-wired one would mean two routers
// competing for the same browser history, for no functional benefit.

export const ROUTES = {
  login: "/login",
  dashboard: "/",
  notFound: "/404",
  // Future routes, to be added to App.tsx's <Switch> in Session 3:
  // patients: "/patients",
  // patientDetail: "/patients/:id",   // use an opaque patient id, not a name, per the audit's HIPAA note
  // claims: "/claims",
} as const;
