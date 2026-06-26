// Project selector component — data + functions
//
// Allows users to select a project and filter sessions by project.

import { css } from "@linaria/core";
import { Button, Select, Option } from "haze-ui";
import { useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Project = {
  id: string;
  name: string;
  directory: string;
};

type ProjectSelectorProps = {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onCreateProject?: (name: string, directory: string) => void;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const container = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
`;

const selectWrapper = css`
  flex: 1;
  min-width: 0;
`;

const addButton = css`
  flex-shrink: 0;
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectSelector({
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
}: ProjectSelectorProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDirectory, setNewDirectory] = useState("");

  const handleCreate = useCallback(() => {
    if (newName.trim() && newDirectory.trim() && onCreateProject) {
      onCreateProject(newName.trim(), newDirectory.trim());
      setNewName("");
      setNewDirectory("");
      setIsCreating(false);
    }
  }, [newName, newDirectory, onCreateProject]);

  return (
    <div className={container}>
      <div className={selectWrapper}>
        <Select
          value={selectedProjectId ?? ""}
          onChange={(value) => onSelectProject(value || null)}
          placeholder="选择项目..."
        >
          <Option value="">全部项目</Option>
          {projects.map((project) => (
            <Option key={project.id} value={project.id}>
              {project.name}
            </Option>
          ))}
        </Select>
      </div>
      {onCreateProject && (
        <Button
          className={addButton}
          size="sm"
          variant="ghost"
          onClick={() => setIsCreating(!isCreating)}
        >
          + 新建
        </Button>
      )}
      {isCreating && (
        <div className={selectWrapper}>
          <input
            type="text"
            placeholder="项目名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: "100%", padding: "4px 8px", fontSize: "12px" }}
          />
          <input
            type="text"
            placeholder="项目目录"
            value={newDirectory}
            onChange={(e) => setNewDirectory(e.target.value)}
            style={{ width: "100%", padding: "4px 8px", fontSize: "12px", marginTop: "4px" }}
          />
          <Button size="sm" onClick={handleCreate} style={{ marginTop: "4px" }}>
            创建
          </Button>
        </div>
      )}
    </div>
  );
}

export default ProjectSelector;
