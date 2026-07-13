# NYC Home Rehab Dashboard — UI/UX Audit

**Date:** 2026-07-13
**Scope:** Read-only structural and design audit, prepared ahead of a possible UI/UX refresh inspired by a Cadre-style project-management reference layout (left sidebar, top toolbar, tabs, stat rows, filter bar, card grid). No code was modified to produce this document.

---

## 1. Component Inventory

### Custom app components (`client/src/components/`, top level)

| Component | Path | Purpose | Lines | Live in app? |
|---|---|---|---|---|
| `ErrorBoundary` | `components/ErrorBoundary.tsx` | React error boundary | 62 | **Yes** — wraps the app in `App.tsx` |
| `AIChatBox` | `components/AIChatBox.tsx` | Chat widget UI | 335 | No — only imported by the unrouted `ComponentShowcase.tsx` |
| `DashboardLayout` | `components/DashboardLayout.tsx` | Full app-shell layout: shadcn `Sidebar`/`SidebarProvider`, top bar, `useAuth`, avatar/dropdown | 276 | **No — dead code.** Not imported anywhere. This is the one file in the repo that already implements something close to the reference design's sidebar pattern, but it's unused. |
| `DashboardLayoutSkeleton` | `components/DashboardLayoutSkeleton.tsx` | Loading skeleton for the above | 46 | No — same orphan status |
| `Logo` | `components/Logo.tsx` | Renders clinic logo in variant/size props | 40 | No — Dashboard imports the PNG asset directly instead |
| `ManusDialog` | `components/ManusDialog.tsx` | Generic login modal scaffold | 89 | No |
| `Map` | `components/Map.tsx` | Google Maps wrapper/integration guide | 155 | No |

**Finding:** 6 of 7 custom top-level components are dead code, left over from a starter template. Only `ErrorBoundary` is actually used. This matters directly for the redesign question: `DashboardLayout.tsx` already has a working sidebar shell in the reference-design style — it was simply never wired up.

### shadcn/ui primitives (`client/src/components/ui/`)

53 generated files (button, card, dialog, tabs, sidebar, table, badge, etc. — the standard Radix-based shadcn set). These are available but several are unused in the live app (notably `Tabs` and `Sidebar` — see Section 3/7).

### Pages (`client/src/pages/`)

| Page | Lines | Routed? |
|---|---|---|
| `Dashboard.tsx` | **3,483** | Yes, at `/` |
| `Login.tsx` | 138 | Yes, at `/login` |
| `NotFound.tsx` | 52 | Yes, fallback |
| `ComponentShowcase.tsx` | 1,437 | **No** — dead code, not referenced by any route |
| `Home.tsx` | 31 | **No** — boilerplate placeholder ("replace with your own feature implementation"), unreferenced |

**Finding:** `Dashboard.tsx` is the entire application. It is not decomposed into `PatientList`, `PatientDetail`, `ClaimsTable`, etc. — those are all inline JSX inside one 2,767-line function body (`export default function Dashboard()`, lines 716–3483). ~48 separate `useState` hooks live in this one component.

---

## 2. Page/Route Structure

- **Router:** `wouter` (not react-router).
- **Routes:** `/login` → `Login`; `/` → `Dashboard` (behind a `ProtectedRoute` gated by `trpc.auth.me`); `/404` and any unmatched path → `NotFound`.
- **Effectively 3 destinations total.** There is no `/patients/:id`, `/claims`, `/settings`, etc.
- **Entry point:** `/` — the patient-list-plus-KPI dashboard view (Section 7 diagrams it).
- **Primary user journeys**, both entirely within the single `/` route via local state, not navigation:
  1. Log in → land on patient-list dashboard → click a patient → view their claims tracker (still same URL, `showDetailView` flips to `true`) → upload an EOB or CMS1500 → review extracted claims → save.
  2. Add a new patient → set authorization → log sessions → track claims to approval.

---

## 3. Layout Structure

- **No persistent sidebar or top nav in the live app.** (`DashboardLayout.tsx`, which has one, is dead code — see Section 1.)
- **Header:** a full-width banner (logo, title, Sign Out, Bulk Upload) rendered once at the top of `Dashboard.tsx`, not a reusable component.
- **Grid system:** ad hoc Tailwind flex/grid per section, not a single consistent 12-column system. The main dashboard view uses a `grid-cols-6` layout (Insurance filter : Claims-status filter : Patient list column, each `col-span-1`, with the remaining columns presumably holding a patient-summary panel — not fully traced in this pass). The claims table itself is a plain HTML `<table>`, not a grid.
- **Max width:** `max-w-[1600px] mx-auto` on the main dashboard content wrapper.
- **Responsive breakpoints:** standard Tailwind (`sm`, `md`, `lg`) used inconsistently — e.g. KPI cards go `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`, but the 6-column filter/list/summary grid has no documented mobile fallback verified in this pass; worth checking on a real small screen before redesign.
- **Comparison to reference:** the reference design's persistent left sidebar + top toolbar + tabbed content is structurally absent today. The closest existing analogs are: the top banner (≈ toolbar, but no breadcrumb/notifications/profile), the vertical Insurance/Claims-status filter panels (≈ a sidebar filter, but scoped to the dashboard view only, not global nav), and the hand-rolled `mainTab` active/discharged toggle (≈ a tab row, but not using the shadcn `Tabs` component already in the codebase).

---

## 4. Design System Currently in Use

Tailwind v4 CSS-first config, defined in `client/src/index.css` (no `tailwind.config.ts` file exists).

**Brand palette** (as CSS variables, exposed as `brand-blue`/`brand-gold`/`brand-cream` utilities):
```
--navy:  #1E3A5F   --navy-light:  #2C5282   --navy-dark:  #152A47
--gold:  #E8A93C   --gold-light:  #F5C563   --gold-dark:  #C88A20
--cream: #FAF5EE   --cream-dark:  #F0E9DC
```
These match exactly what you've specified as locked for the redesign.

**Finding — inconsistent consumption:** despite the named `brand-blue`/`brand-gold`/`brand-cream` utilities existing, both `App.tsx` and `Dashboard.tsx` frequently hardcode raw hex arbitrary-value classes instead (`bg-[#FAF5EE]`, `border-[#1E3A5F]`, `text-[#E8A93C]`) rather than the named tokens. Functionally identical today, but it means a future color adjustment would require a find-and-replace across raw hex literals rather than one variable change — worth normalizing during any redesign pass, independent of whether colors themselves change.

**Typography:** Playfair Display (serif, 600/700) for all headings — forced via a base-layer rule; Inter (sans, 400–700) for body text. Consistently applied via the base rule rather than ad hoc.

**Shadows:** `--shadow-brand` / `--shadow-brand-lg`, tuned to the navy tone.

**Radius:** `--radius: 0.65rem` with derived sm/md/lg/xl scale (standard shadcn convention).

**Icon library:** `lucide-react`.

**Charting:** `recharts` (used at least for the KPI/trend area — not fully audited for count of chart instances in this pass).

**Dark mode:** a `.dark` CSS block exists with generic blue/oklch tokens **not tied to the brand palette** — if dark mode is ever triggered (e.g. via `next-themes`, which is installed), the app would visually diverge from the brand navy/gold/cream. Worth deciding whether dark mode is in scope at all; if not, this divergent block is effectively dead weight.

**Buttons/badges/cards:** shadcn primitives (`Button`, `Badge`, `Card`) are used throughout, generally consistently, though many one-off styling overrides are layered on via `className` (e.g. custom status-color maps for claim badges defined inline in `Dashboard.tsx` rather than as a shared badge-variant map).

---

## 5. State Management

- **No global state library** — no Zustand, Redux, Jotai, or Recoil anywhere in the codebase.
- **Server state / data fetching:** tRPC + TanStack React Query exclusively (`trpc.*.useQuery` / `useMutation`). This is a reasonable, modern choice and is used consistently.
- **Client UI state:** ~48 `useState` calls inside the single `Dashboard` component — patient selection, view toggles, dialog open/closed flags, editing-cell state, upload progress, filter selections, etc. all live together in one component's closure.
- **Context API:** one app-level context, `ThemeContext` (wraps the whole app for light/dark theme). Everything else using `createContext` is internal to shadcn primitives (dialog, sidebar, form, etc. — implementation detail, not app state).
- **Auth state:** `client/src/_core/hooks/useAuth.ts`, itself a thin wrapper over `trpc.auth.me`/`trpc.auth.logout`. `App.tsx`'s route guard calls `trpc.auth.me.useQuery()` directly rather than going through the hook — a minor inconsistency, not a bug.
- **Risk assessment:** with 48 co-located `useState` calls and no separate view components, there's real prop-drilling risk if the redesign tries to extract sub-components (e.g. a standalone `PatientList` or `ClaimsTable`) — those would each need a defined, intentional prop contract carved out of what's currently just closures over shared local variables. This is the single biggest structural cost of any "selective adoption" or "hybrid" redesign path: extracting even one section into its own component means deciding what state it owns vs. receives as props.

---

## 6. API Integration

All access is via tRPC (`server/routers.ts`, 736 lines), consumed through typed `trpc.*` hooks — there are no separate REST fetch calls in the claims/patient/visit domain (the one exception, `/api/claims/upload-extract`, is a raw `fetch()` POST for the file-upload multipart flow, since tRPC doesn't handle file uploads natively).

**Router groups:**
- `auth.*` — `me`, `logout`
- `clinic.*` — `login`
- `patients.*` — `list`, `get`, `create`, `update`, `delete`, `setActive`
- `visits.*` — `listByPatient`, `create`, `update`, `bulkCreate`, `authAlerts`, `approveAuthorization`, `completedPatientIds`, `markAsRequested`
- `claims.*` — `getByPatientAndPeriod`, `create`, `update`, `delete`, `upsert`, `bulkImportFromEOB`, `markResolved`, `getZeroReimbursement`

**Error handling:** tRPC's standard error surface (`onError` callbacks feeding `sonner` toasts) — consistent pattern, not ad hoc per call.

**Loading state:** React Query's `isLoading`/`isPending` flags, generally respected (spinners on buttons during mutations) — not comprehensively verified across every call site in this pass.

---

## 7. User Workflows Currently Supported

Walked from the code (not from live clicking, since this session doesn't include running the app):

| Workflow | Entry point | Friction observed from code |
|---|---|---|
| Log in | `/login` form | Standard, no issues apparent |
| View patient list | Land on `/` | List is a scrollable column, not a card grid or table — compact but limited at-a-glance info (name, insurance, one status badge) |
| Select a patient | Click name in list | Toggles `showDetailView`/`selectedPatientId` — no URL change, so back button / bookmarking / sharing a link to one patient's view doesn't work |
| Add a patient | "Add Patient" flow (dialog) | Not fully traced this pass |
| Upload EOB/CMS1500 | Buttons inside a patient's claims card, per auth period | Multi-stage: select file → server extraction → review screen (editable, shows verification-flag icons) → save. This is the most heavily engineered workflow in the app (per this whole engagement's history) and is deliberately conservative about auto-saving unverified data. |
| Approve/edit a claim | Inline-editable table cells in the claims tracker | Click-to-edit per cell — functional, if a little fiddly for bulk corrections (Session-Goal-2's proposed correction UI would sit here) |
| Filter claims/patients | Insurance sidebar panel + Claims-status panel (two separate vertical lists, not a combined filter bar) | Functional but visually disconnected from the list they filter — reference design's single filter bar pattern (Section 10, Pattern 7) would consolidate this |
| View authorization periods / alerts | `AuthAlertPanel`, `ZeroReimbursementPanel` on the main dashboard | Two distinct alert-panel components, each with their own card styling |
| Export claims to CSV | Export button next to Columns toggle, per period | Added this engagement; straightforward |

---

## 8. What Works Well (Preserve These)

**Functional / backend (from this whole engagement's hardening work):**
- The multi-stage PDF extraction fallback chain (pdftotext → pdfjs layout reconstruction → flat text → vision).
- Patient-scoping via fuzzy name matching, with three previously-real cross-patient leak points closed.
- The source-text verification gate (flags, doesn't silently drop, per your explicit choice) including the same-line co-occurrence check for pattern-completion fabrication.
- The 18-canonical-column claim schema and its near-exact match to the real Postgres table.
- CSV export, column-visibility toggle defaulting to the 18 canonical columns.

**Visual / UX:**
- Brand palette (navy/gold/cream) and Playfair/Inter typography pairing are cohesive and consistently themed via the base layer.
- KPI stat-card row on the main dashboard is already conceptually aligned with the reference design's stat-row pattern (Section 10, Pattern 4) — this doesn't need to be invented, just possibly restyled.
- Claim-status color coding (badges) is used consistently across the patient list, claims table, and filter panel.
- The alert-panel pattern (`AuthAlertPanel`, `ZeroReimbursementPanel`) surfacing "needs attention" items directly on the landing view is a genuinely good piece of UX for billing staff — worth preserving and possibly extending, not replacing.

---

## 9. Pain Points and Opportunities

(Documenting only — no proposed fixes here, per your instructions.)

- `Dashboard.tsx` is a single 3,483-line file / ~2,767-line function. Any redesign work that touches layout will be editing inside this one file unless components are deliberately extracted first.
- No URL reflects the current view — patient selection, active/discharged tab, and claims filters are all local state. Can't deep-link, bookmark, or use browser back/forward to navigate within the app.
- Two separate vertical filter panels (Insurance, Claims Status) sit beside the patient list rather than being a unified filter bar — visually fragmented compared to a single search+filter row.
- Patient list is a dense text list, not a card layout — less scannable than a card grid would be, though also more compact (a real tradeoff, not a strict downgrade).
- Brand colors are defined as named Tailwind tokens but frequently bypassed in favor of raw hex arbitrary-value classes — inconsistent even though visually correct today.
- A `.dark` theme block exists but uses generic (non-brand) colors, and `next-themes` is installed — if dark mode is ever reachable by a user, it currently breaks brand consistency.
- ~48 co-located `useState` hooks in one component is a real extraction cost for any redesign that wants standalone, reusable sub-components.
- Six unused/orphaned components (including a fully-built sidebar shell in `DashboardLayout.tsx`) and two unrouted pages exist as dead code — not harmful, but worth a decision (delete vs. repurpose) since `DashboardLayout.tsx` in particular is directly relevant to a sidebar-pattern redesign.
- The claims table (`<table>`) doesn't have the horizontal-scroll issue called out here as a problem, but with 18 columns visible by default plus inline editing, it is dense; no responsive/mobile fallback verified.

---

## 10. Reference Design Pattern Analysis

| Pattern | Reference has | Applicability to this app | Effort |
|---|---|---|---|
| **1. Left sidebar nav w/ grouping** | Main nav + Other section + pinned items | Currently no sidebar at all (dead code exists in `DashboardLayout.tsx`). Since the app has effectively one screen today, a sidebar's main value would be as a **navigation target for future screens** (e.g. separate Patients/Claims/Reports views) rather than solving an immediate problem — the audit didn't find multiple destinations that need a sidebar to switch between *today*. Real payoff depends on whether the redesign also splits the single-page app into more distinct sections. | Medium (shell exists, needs wiring + deciding what goes in it) |
| **2. Top toolbar (breadcrumb, icons, CTA, profile)** | Back-breadcrumb, message/notification icons, team/project buttons, avatar | The current header (logo, title, Sign Out, Bulk Upload) is a simpler version of this already. Breadcrumb doesn't apply cleanly since there's no route hierarchy yet. Notification/message icons don't map to anything this app currently has. | Small–Medium |
| **3. Tabbed content area** | PROJECT DETAILS / POSITION DETAILS / PREFERENCE tabs | Strong fit for a patient's detail view — Overview / Claims / Authorizations could genuinely replace today's single scrolling patient-detail page, and the shadcn `Tabs` component is already installed and unused. | Small–Medium |
| **4. Horizontal stat card row** | 5 stat cards | **Already exists** (4 KPI cards on the main dashboard). Adopting the reference's specific compact styling is a restyle, not new structure. | Small |
| **5. Metadata row below stats** | Start/End date, Location, Number, PM | Could apply to a patient's header (insurance, current auth period, sessions remaining, next appointment) — there's no such compact metadata strip today; patient info is spread across the detail view. | Small–Medium |
| **6. Sub-tab row with counts** | FREELANCER (12) / OFFERS / CONTRACTS (3)... | Strong fit for claims status filtering — today's status filter is a vertical list of buttons with counts; converting it to a horizontal count-tab row (All (45) / Submitted (12) / Approved (23)...) is a direct, low-risk translation of an existing pattern into the reference's visual language. | Small |
| **7. Search + toggle + filter bar** | Search input, toggle, Filters button | Would consolidate the two separate Insurance/Claims-status vertical panels into one horizontal bar — directly addresses the fragmentation noted in Section 9. | Medium |
| **8. Card grid (avatar, name, rating, actions)** | Cards with avatar/rating/location/rate | Could replace the current dense patient list with a card grid (name, insurance, status badge, quick actions) — higher visual impact, but trades list density for scannability; for billing staff triaging many patients, this is a genuine UX judgment call, not a clear win. | Medium–Large |

---

## 11. Constraints for Redesign

- Brand colors locked: Navy `#1E3A5F`, Gold `#E8A93C`, Cream `#FAF5EE` — no changes.
- Extraction pipeline, verification gate, and patient-scoping logic are backend/server concerns and are out of scope for a UI redesign regardless — nothing here should touch `server/aiClaimExtractor.ts`, `server/nameMatch.ts`, `server/claimUpload.ts`.
- The 18 canonical claims columns remain the data contract.
- Existing workflows (upload → review → save; inline claim editing; CSV export) must keep working — this is a refinement, not a rebuild, unless Option A (Section 12) is explicitly chosen.
- No new dependencies without justification — though note `wouter`, all needed Radix/shadcn primitives (including `Tabs` and `Sidebar`), `recharts`, and `lucide-react` are already installed; the reference patterns above are achievable without adding anything new.
- HIPAA-aware: no patient data in URLs if routing is introduced (use opaque IDs, not names, in any future `/patients/:id`-style route), no new tracking scripts.

---

## 12. Recommended Approach for Redesign

**Recommendation: Option C (Hybrid), with a specific sequencing caveat.**

Reasoning:
- Option A (full restructure) is hard to justify — the audit didn't surface a broken or missing navigation problem that a full sidebar rebuild would solve; the app has one real screen today, and a full restructure's main deliverable would be visual, not functional.
- Option B (selective adoption, pattern-by-pattern) is the lowest-risk path and should genuinely be **where this starts** — Patterns 3, 4, 5, 6, and 7 (tabs, stat-row restyle, patient-header metadata strip, count-tab claims filter, unified filter bar) are all small-to-medium, additive, and don't require extracting `Dashboard.tsx` into sub-components first.
- Option C (adopt the sidebar shell, keep content design, refine progressively) only becomes worthwhile *after* Option B's patterns are in place and you've confirmed (via Section 13's open questions) that multiple real destinations are wanted — otherwise a sidebar is nav-for-navigation's-sake.

**Suggested sequencing, not full sessions, since scope varies:**
1. Adopt Patterns 4, 6, 7 first (stat-row restyle, count-tab claims filter, unified filter bar) — all touch the existing dashboard grid, no new routes, no component extraction needed, directly resolve the fragmentation pain point in Section 9.
2. Adopt Pattern 3 (tabs) for the patient-detail view, since `Tabs` is already installed and this is where the 2,767-line single function most needs internal structure regardless of visual redesign.
3. Only then evaluate Pattern 1 (sidebar) — by that point you'll know whether the tabbed patient-detail view creates enough distinct "places" to justify persistent nav, or whether it's still comfortably one screen.

**Assumptions:** billing-staff efficiency (fast scanning, minimal clicks between patients) matters more here than the reference design's recruiting/project-management context assumes — worth confirming in Section 13.

**Risks:** any pattern that requires extracting a sub-component (going beyond a pure JSX/className change inside the existing function) inherits the prop-drilling cost noted in Section 5 — budget for that explicitly rather than treating it as incidental.

---

## 13. Questions for the User

1. Is a persistent left sidebar actually wanted, or would you rather keep the single-screen model and just improve it in place (Option B only, skip C)?
2. If a sidebar is wanted — what would it actually navigate *to*? The audit didn't find multiple existing destinations; would new sections (e.g. a dedicated Reports view, a Settings view) be introduced alongside the redesign, or is this purely a visual reorganization of what exists today?
3. Should patient selection remain a list-click (as now) or become a routed `/patients/:id`-style view (enabling back-button/bookmark/deep-link support)? This has real implementation cost (introducing route params) but fixes a genuine gap noted in Section 9.
4. Is the current patient list's density (compact text list) preferred over a card grid, or is more visual scannability worth the space tradeoff?
5. Is mobile/tablet usage expected in practice for this billing staff workflow, and if so, which specific workflows (upload? review? just viewing status?) need to work on a small screen?
6. On the six orphaned/dead components — particularly `DashboardLayout.tsx`, which already has a working sidebar shell — should these be deleted, or were they left in place intentionally as a starting point for exactly this kind of redesign?
7. Any specific elements from the reference design you've already decided you don't want (e.g. the message/notification icons, which don't map to anything this app currently has)?
8. Any specific elements of the *current* dashboard you want preserved as-is regardless of the redesign (beyond brand colors, which are already locked)?

---

*No component was modified, no styling was changed, and no new files other than this document were created in the course of this audit.*
