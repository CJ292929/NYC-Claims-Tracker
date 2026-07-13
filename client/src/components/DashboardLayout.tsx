import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  FileText,
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Settings,
  User,
  Users,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Logo } from "./Logo";
import { Button } from "./ui/button";

// Session 3 will wire these to real wouter routes. For now, path is used only
// for the (currently hardcoded) mobile top-bar label lookup.
const mainNavItems = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard", path: "/" },
  { id: "patients", icon: Users, label: "Patients", path: "/patients" },
  { id: "claims", icon: FileText, label: "Claims", path: "/claims" },
  { id: "reports", icon: BarChart3, label: "Reports", path: "/reports", disabled: true },
];

const toolsNavItems = [
  // Bulk Upload is intentionally not listed here -- it's a real, working
  // feature already in Dashboard.tsx's header (showUploadDialog /
  // handleBulkUpload), not an unbuilt one. Labeling a sidebar item "Coming
  // Soon" next to a live feature of the same name would be misleading.
  { id: "settings", icon: Settings, label: "Settings", path: "/settings", disabled: true },
];

const accountNavItems = [
  { id: "profile", icon: User, label: "Profile", path: "/profile", disabled: true },
];

const menuItems = [...mainNavItems, ...toolsNavItems, ...accountNavItems];

/**
 * "/" and "/patients" (and "/patients/:id") all render the same patient
 * list/detail content -- this app has no separate dashboard-only view --
 * so both map to the "patients" nav item being active. Dashboard.tsx's own
 * URL sync immediately canonicalizes "/" to "/patients" once patients load,
 * so the "/" case here only matters for the brief moment before that redirect.
 */
function getActiveNavId(location: string): string {
  if (location.startsWith("/patients")) return "patients";
  if (location.startsWith("/claims")) return "claims";
  if (location === "/") return "dashboard";
  return "";
}

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

/**
 * The underlying shadcn Sidebar primitive writes an `open` cookie
 * (sidebar_state) on every toggle but never reads it back on mount -- this
 * is a Vite SPA, not SSR, so nothing ever consulted that cookie, and the
 * collapse state didn't actually survive a reload despite appearing to.
 * Reading it here (via SidebarProvider's own `defaultOpen` prop) fixes
 * that, and also gives tablet widths a collapsed-by-default starting
 * point distinct from desktop, without touching the shared primitive.
 */
function getInitialSidebarOpen(): boolean {
  if (typeof document !== "undefined") {
    const cookieMatch = document.cookie.match(/(?:^|; )sidebar_state=(true|false)/);
    if (cookieMatch) return cookieMatch[1] === "true";
  }
  if (typeof window !== "undefined" && window.innerWidth >= 768 && window.innerWidth < 1024) {
    return false;
  }
  return true;
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const [defaultSidebarOpen] = useState(getInitialSidebarOpen);
  const { loading, user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  if (!user) {
    // In practice App.tsx's ProtectedRoute already redirects to /login before
    // this ever renders. This is a fallback, not the primary sign-in path --
    // it must point at the real /login route (username/password form), not
    // an OAuth portal URL this app doesn't use.
    return (
      <div className="flex items-center justify-center min-h-screen bg-brand-cream">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full bg-card rounded-xl border border-border shadow-brand">
          <div className="flex flex-col items-center gap-6">
            <Logo variant="full" size="lg" />
            <div className="flex flex-col items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-center text-brand-blue">
                Sign in to continue
              </h1>
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                Access to this dashboard requires authentication. Continue to launch the login flow.
              </p>
            </div>
          </div>
          <Button
            onClick={() => setLocation("/login")}
            size="lg"
            className="w-full bg-brand-blue hover:bg-brand-blue-dark text-white shadow-md hover:shadow-lg transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      defaultOpen={defaultSidebarOpen}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeNavId = getActiveNavId(location);
  const activeMenuItem = menuItems.find(item => item.id === activeNavId);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r-0"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-sidebar-accent/20 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-sidebar-foreground/70" />
              </button>
              {!isCollapsed ? (
                <div className="flex items-center gap-2 min-w-0">
                  <Logo variant="white" size="sm" className="h-8 shrink-0" />
                  <span className="font-serif font-semibold tracking-tight truncate text-sidebar-foreground">
                    NYC Home Rehab
                  </span>
                </div>
              ) : (
                <Logo variant="white" size="sm" className="h-8 shrink-0" />
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            <SidebarGroup>
              <SidebarGroupLabel>Main</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="px-2 py-1">
                  {mainNavItems.map(item => {
                    const isActive = item.id === activeNavId;
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={isActive}
                          aria-disabled={item.disabled}
                          onClick={() => {
                            if (item.disabled) return;
                            setLocation(item.path);
                            if (isMobile) setOpenMobile(false);
                          }}
                          tooltip={item.disabled ? "Coming Soon" : item.label}
                          className={cn(
                            "h-10 transition-all font-normal border-l-4 border-transparent",
                            isActive && "border-l-brand-gold font-medium",
                            item.disabled && "cursor-not-allowed"
                          )}
                        >
                          <item.icon
                            className={`h-4 w-4 ${isActive ? "text-sidebar-accent-foreground" : ""}`}
                          />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>Tools</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="px-2 py-1">
                  {toolsNavItems.map(item => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        aria-disabled={item.disabled}
                        onClick={() => {
                          if (item.disabled) return;
                          console.log(`[nav] ${item.label} clicked -- routing added in Session 3`);
                        }}
                        tooltip="Coming Soon"
                        className="h-10 transition-all font-normal border-l-4 border-transparent cursor-not-allowed"
                      >
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup className="mt-auto">
              <SidebarGroupLabel>Account</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="px-2 py-1">
                  {accountNavItems.map(item => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        aria-disabled={item.disabled}
                        onClick={() => {
                          if (item.disabled) return;
                          console.log(`[nav] ${item.label} clicked -- routing added in Session 3`);
                        }}
                        tooltip="Coming Soon"
                        className="h-10 transition-all font-normal border-l-4 border-transparent cursor-not-allowed"
                      >
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={logout}
                      tooltip="Sign Out"
                      className="h-10 transition-all font-normal border-l-4 border-transparent text-destructive hover:text-destructive"
                    >
                      <LogOut className="h-4 w-4" />
                      <span>Sign Out</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex border-b border-brand-cream-dark h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <Logo variant="icon" size="sm" className="h-7" />
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-brand-blue font-medium">
                    {activeMenuItem?.label ?? "Menu"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 p-4">{children}</main>
      </SidebarInset>
    </>
  );
}
