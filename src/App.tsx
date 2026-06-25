import { cx } from "@linaria/core";
import { Button, Spinner, ToastContainer } from "haze-ui";
import { type ComponentType, Suspense, useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfigProvider } from "./contexts/ConfigContext";
import { useConfig } from "./hooks/useConfig";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { AppQueryProvider } from "./hooks/useQueryClient";
import { ROUTE_NAV_ITEMS } from "./router";
import { globalStyles } from "./styles/global";
import { type ThemeMode, resolveThemeClass } from "./utils/theme";

// Lazy load pages
const SettingsPage = async () => import("./pages/SettingsPage");
const ChatPage = async () => import("./pages/ChatPage");

function ProtectedRoute() {
  const { isConfigured, isLoading } = useConfig();
  if (isLoading) return null;
  if (!isConfigured) return <Navigate to="/settings" replace />;
  return <Outlet />;
}

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { config, logout } = useConfig();
  const { canInstall, install } = useInstallPrompt();

  return (
    <div>
      <header
        style={{
          height: 64,
          borderBottom: "1px solid var(--haze-color-border)",
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>c0de-agent</span>
          <nav style={{ display: "flex", gap: 8 }}>
            {ROUTE_NAV_ITEMS.map((item) => (
              <Button
                key={item.path}
                variant={location.pathname === item.path ? "solid" : "ghost"}
                size="sm"
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {canInstall && (
            <Button variant="ghost" size="sm" onClick={install}>
              安装应用
            </Button>
          )}
          {config && (
            <span style={{ fontSize: 12, color: "var(--haze-color-text-muted)" }}>
              {config.model}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={logout}>
            退出
          </Button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

function PageFallback() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
      <Spinner />
    </div>
  );
}

// Simple lazy wrapper
function LazyPage({ loader }: { loader: () => Promise<{ default: ComponentType<unknown> }> }) {
  const [Comp, setComp] = useState<ComponentType<unknown> | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useState(() => {
    loader()
      .then((m) => setComp(() => m.default))
      .catch(setError);
  });

  if (error) throw error;
  if (!Comp) return <PageFallback />;
  return <Comp />;
}

export function App() {
  const [themeClass, setThemeClass] = useState(() => {
    const saved = localStorage.getItem("c0de-theme") as ThemeMode | null;
    return resolveThemeClass(saved ?? "system");
  });

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const saved = localStorage.getItem("c0de-theme") as ThemeMode | null;
      if (saved && saved !== "system") return;
      setThemeClass(resolveThemeClass("system"));
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Sync when localStorage changes (e.g. from Settings page)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "c0de-theme") {
        setThemeClass(resolveThemeClass((e.newValue as ThemeMode) ?? "system"));
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <div className={cx(globalStyles, themeClass)}>
      <ErrorBoundary>
        <AppQueryProvider>
          <ConfigProvider>
            <BrowserRouter>
              <ToastContainer>
                <Suspense fallback={<PageFallback />}>
                  <Routes>
                    <Route element={<ProtectedRoute />}>
                      <Route element={<AppLayout />}>
                        <Route
                          path="/chat"
                          element={<LazyPage loader={() => import("./pages/ChatPage")} />}
                        />
                        <Route path="/" element={<Navigate to="/chat" replace />} />
                      </Route>
                    </Route>
                    <Route
                      path="/settings"
                      element={<LazyPage loader={() => import("./pages/SettingsPage")} />}
                    />
                  </Routes>
                </Suspense>
              </ToastContainer>
            </BrowserRouter>
          </ConfigProvider>
        </AppQueryProvider>
      </ErrorBoundary>
    </div>
  );
}
