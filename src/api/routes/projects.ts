// Project routes — CRUD API for projects
//
// POST   /api/projects              — create a new project
// GET    /api/projects              — list all projects
// GET    /api/projects/:id          — get project detail
// PATCH  /api/projects/:id          — update project
// DELETE /api/projects/:id          — delete project

import { Hono } from "hono";
import {
  createProject,
  deleteProject,
  fromDirectory,
  getProject,
  listProjects,
  updateProject,
} from "../../session/project";
import { badRequest, notFound, safeJson } from "../helpers";
import type { ServerDeps } from "../index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeProject(project: {
  id: string;
  name: string;
  directory: string;
  description?: string | null;
  icon?: string | null;
  vcs?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    directory: project.directory,
    description: project.description,
    icon: project.icon,
    vcs: project.vcs,
    metadata: project.metadata,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProjectRoutes(app: Hono, deps: ServerDeps): void {
  // POST /api/projects — create a new project
  app.post("/api/projects", async (c) => {
    const body = await safeJson(c);
    if (!body?.name || typeof body.name !== "string") {
      return badRequest(c, "name is required");
    }
    if (!body?.directory || typeof body.directory !== "string") {
      return badRequest(c, "directory is required");
    }

    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const project = await createProject(store, {
      name: body.name,
      directory: body.directory,
      description: body.description,
    });

    return c.json(serializeProject(project), 201);
  });

  // GET /api/projects — list all projects
  app.get("/api/projects", async (c) => {
    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const projects = await listProjects(store);
    return c.json(projects.map(serializeProject));
  });

  // GET /api/projects/current — get current project (based on WORKING_DIRECTORY)
  // Must be before :id route
  app.get("/api/projects/current", async (c) => {
    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const workingDir = deps.workingDirectory;
    if (!workingDir) return notFound(c, "No working directory configured");

    const projects = await listProjects(store);
    const current = projects.find((p) => p.directory === workingDir);
    if (!current) return notFound(c, "No project found for current directory");

    return c.json(serializeProject(current));
  });

  // GET /api/projects/:id — get project detail
  app.get("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const project = await getProject(store, id);
    if (!project) return notFound(c, `Project not found: ${id}`);
    return c.json(serializeProject(project));
  });

  // PATCH /api/projects/:id — update project
  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const project = await getProject(store, id);
    if (!project) return notFound(c, `Project not found: ${id}`);

    const body = await safeJson(c);
    if (!body || typeof body !== "object") {
      return badRequest(c, "Request body must be a JSON object");
    }

    await updateProject(store, id, {
      ...(body.name ? { name: body.name } : {}),
      ...(body.directory ? { directory: body.directory } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });

    const updated = await getProject(store, id);
    return c.json(serializeProject(updated!));
  });

  // DELETE /api/projects/:id — delete project
  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const project = await getProject(store, id);
    if (!project) return notFound(c, `Project not found: ${id}`);

    await deleteProject(store, id);
    return c.json({ deleted: true });
  });

  // POST /api/projects/from-directory — create or get a project from directory
  app.post("/api/projects/from-directory", async (c) => {
    const body = await safeJson(c);
    if (!body?.directory || typeof body.directory !== "string") {
      return badRequest(c, "directory is required");
    }

    const store = deps.sessionStore;
    if (!store) return badRequest(c, "Session store not available");

    const project = await fromDirectory(store, body.directory, {
      name: body.name,
      vcs: body.vcs,
    });

    return c.json(serializeProject(project));
  });
}
