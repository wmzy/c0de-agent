// Projects page — manage projects and their directories

import { css } from "@linaria/core";
import { Button, Card, Input, Spinner } from "haze-ui";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Project = {
  id: string;
  name: string;
  directory: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const page = css`
  max-width: 800px;
  margin: 0 auto;
  padding: 48px 24px;
`;

const title = css`
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
`;

const subtitle = css`
  color: var(--haze-color-text-secondary);
  margin-bottom: 32px;
`;

const projectCard = css`
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--haze-color-border);
  border-radius: var(--haze-radius-md);
  background: var(--haze-color-bg);
  cursor: pointer;
  transition: border-color 0.15s ease;

  &:hover {
    border-color: var(--haze-color-accent);
  }
`;

const projectName = css`
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
`;

const projectDir = css`
  font-size: 12px;
  color: var(--haze-color-text-muted);
  font-family: monospace;
`;

const projectDesc = css`
  font-size: 14px;
  color: var(--haze-color-text-secondary);
  margin-top: 8px;
`;

const formCard = css`
  padding: 20px;
  border: 1px solid var(--haze-color-border);
  border-radius: var(--haze-radius-md);
  background: var(--haze-color-bg-secondary);
  margin-bottom: 24px;
`;

const formRow = css`
  display: flex;
  gap: 12px;
  margin-bottom: 12px;

  & > * {
    flex: 1;
  }
`;

const emptyState = css`
  text-align: center;
  padding: 48px 0;
  color: var(--haze-color-text-muted);
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDir, setNewDir] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [saving, setSaving] = useState(false);

  // Fetch projects
  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => setProjects(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Create project
  const handleCreate = useCallback(async () => {
    if (!newName.trim() || !newDir.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          directory: newDir.trim(),
          description: newDesc.trim() || undefined,
        }),
      });
      if (res.ok) {
        const project = await res.json();
        setProjects((prev) => [project, ...prev]);
        setNewName("");
        setNewDir("");
        setNewDesc("");
        setShowForm(false);
      }
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setSaving(false);
    }
  }, [newName, newDir, newDesc]);

  // Delete project
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("确定删除此项目？会话将不会被删除。")) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== id));
      }
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  }, []);

  // Select project and go to chat
  const handleSelect = useCallback(
    (projectId: string) => {
      localStorage.setItem("c0de-active-project", projectId);
      navigate("/chat");
    },
    [navigate],
  );

  if (loading) {
    return (
      <div className={page}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className={page}>
      <h1 className={title}>项目管理</h1>
      <p className={subtitle}>管理你的项目，每个项目绑定一个工作目录</p>

      {/* Create form */}
      {showForm ? (
        <div className={formCard}>
          <div className={formRow}>
            <Input
              placeholder="项目名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Input
              placeholder="工作目录 (如 /home/user/my-project)"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
            />
          </div>
          <Input
            placeholder="描述 (可选)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button onClick={handleCreate} disabled={saving || !newName.trim() || !newDir.trim()}>
              {saving ? "创建中..." : "创建"}
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setShowForm(true)} style={{ marginBottom: 24 }}>
          + 新建项目
        </Button>
      )}

      {/* Project list */}
      {projects.length === 0 ? (
        <div className={emptyState}>
          <p>还没有项目</p>
          <p>创建一个项目来开始使用</p>
        </div>
      ) : (
        projects.map((project) => (
          <Card key={project.id} className={projectCard} onClick={() => handleSelect(project.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div className={projectName}>{project.name}</div>
                <div className={projectDir}>{project.directory}</div>
                {project.description && <div className={projectDesc}>{project.description}</div>}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(project.id);
                }}
              >
                删除
              </Button>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
