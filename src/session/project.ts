// Project CRUD — data + functions, no class
//
// Each function takes a SessionStore handle as its first parameter so callers
// can share one store across the whole application.

import type { ProjectData, SessionStore } from "./types";

export type { ProjectData };

// ---------------------------------------------------------------------------
// createProject — create a new project
// ---------------------------------------------------------------------------

export async function createProject(
  store: SessionStore,
  data: Omit<ProjectData, "id" | "createdAt" | "updatedAt">,
): Promise<ProjectData> {
  return store.createProject(data);
}

// ---------------------------------------------------------------------------
// getProject — get a project by id
// ---------------------------------------------------------------------------

export async function getProject(
  store: SessionStore,
  id: string,
): Promise<ProjectData | null> {
  return store.getProject(id);
}

// ---------------------------------------------------------------------------
// listProjects — list all projects
// ---------------------------------------------------------------------------

export async function listProjects(
  store: SessionStore,
): Promise<ProjectData[]> {
  return store.listProjects();
}

// ---------------------------------------------------------------------------
// updateProject — update a project
// ---------------------------------------------------------------------------

export async function updateProject(
  store: SessionStore,
  id: string,
  data: Partial<ProjectData>,
): Promise<void> {
  return store.updateProject(id, data);
}

// ---------------------------------------------------------------------------
// deleteProject — delete a project and unlink its sessions
// ---------------------------------------------------------------------------

export async function deleteProject(
  store: SessionStore,
  id: string,
): Promise<void> {
  return store.deleteProject(id);
}

// ---------------------------------------------------------------------------
// getProjectByDirectory — find a project by its directory path
// ---------------------------------------------------------------------------

export async function getProjectByDirectory(
  store: SessionStore,
  directory: string,
): Promise<ProjectData | null> {
  const projects = await store.listProjects();
  return projects.find((p) => p.directory === directory) ?? null;
}

// ---------------------------------------------------------------------------
// getOrCreateProject — get or create a project by directory
// ---------------------------------------------------------------------------

export async function getOrCreateProject(
  store: SessionStore,
  directory: string,
  name?: string,
): Promise<ProjectData> {
  const existing = await getProjectByDirectory(store, directory);
  if (existing) return existing;

  return store.createProject({
    name: name ?? directory.split("/").pop() ?? "Project",
    directory,
  });
}

// ---------------------------------------------------------------------------
// fromDirectory — create or get a project from a directory path
// Similar to opencode's Project.fromDirectory
// ---------------------------------------------------------------------------

export async function fromDirectory(
  store: SessionStore,
  directory: string,
  options?: { name?: string; vcs?: string },
): Promise<ProjectData> {
  const existing = await getProjectByDirectory(store, directory);
  if (existing) {
    // Update timestamp
    await store.updateProject(existing.id, { updatedAt: new Date() });
    return (await store.getProject(existing.id))!;
  }

  // Create new project from directory
  const dirName = directory.split("/").pop() ?? "Project";
  return store.createProject({
    name: options?.name ?? dirName,
    directory,
    vcs: options?.vcs,
  });
}
