import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "./shell/AppShell";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { ProjectDetailPage } from "./features/projects/ProjectDetailPage";
import { LibraryPage } from "./features/library/LibraryPage";
import { SourcesPage } from "./features/library/SourcesPage";
import { ComponentDetailPage } from "./features/library/ComponentDetailPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { DatasheetsPage } from "./features/ingest/DatasheetsPage";
import { DatasheetDetailPage } from "./features/ingest/DatasheetDetailPage";
import { ExtractionReviewPage } from "./features/ingest/ExtractionReviewPage";
import "./styles.css";

const rootRoute = createRootRoute({ component: AppShell });

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ProjectsPage,
});
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectDetailPage,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});
const componentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/components/$componentId",
  component: ComponentDetailPage,
});
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/sources",
  component: SourcesPage,
});
const datasheetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/datasheets",
  component: DatasheetsPage,
});
const datasheetDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/datasheets/$datasheetId",
  component: DatasheetDetailPage,
});
const extractionReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/runs/$runId",
  component: ExtractionReviewPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  projectsRoute,
  projectDetailRoute,
  libraryRoute,
  sourcesRoute,
  componentDetailRoute,
  datasheetsRoute,
  datasheetDetailRoute,
  extractionReviewRoute,
  settingsRoute,
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
