// Files service — frontend API client for /api/files endpoints.
// Data + functions paradigm: no class, no this.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileEntry = {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
  modified?: string;
};

export type FileContent = {
  path: string;
  content: string;
  size: number;
};

export type ContentSearchResult = {
  path: string;
  name: string;
  line: number;
  content: string;
};

// ---------------------------------------------------------------------------
// browseFiles — GET /api/files?path=...
// ---------------------------------------------------------------------------

export async function browseFiles(
  path: string,
): Promise<{ entries: FileEntry[] }> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);

  const response = await fetch(`/api/files?${params.toString()}`);
  if (!response.ok) throw new Error(`Failed to browse files: ${response.status}`);
  const data = (await response.json()) as { entries: unknown[] };
  return {
    entries: data.entries.map(deserializeFileEntry),
  };
}

// ---------------------------------------------------------------------------
// readFile — GET /api/files/*/raw?path=...
// ---------------------------------------------------------------------------

export async function readFile(filePath: string): Promise<FileContent> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(filePath)}/raw`,
  );
  if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  return {
    path: String(data.path ?? filePath),
    content: String(data.content ?? ""),
    size: Number(data.size ?? 0),
  };
}

// ---------------------------------------------------------------------------
// writeFile — PUT /api/files/*
// ---------------------------------------------------------------------------

export async function writeFile(
  filePath: string,
  content: string,
): Promise<void> {
  const response = await fetch(
    `/api/files/${encodeURIComponent(filePath)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) throw new Error(`Failed to write file: ${response.status}`);
}

// ---------------------------------------------------------------------------
// searchFiles — GET /api/files/search?q=...
// ---------------------------------------------------------------------------

export async function searchFiles(query: string): Promise<FileEntry[]> {
  const response = await fetch(
    `/api/files/search?q=${encodeURIComponent(query)}`,
  );
  if (!response.ok) throw new Error(`Failed to search files: ${response.status}`);
  const data = (await response.json()) as unknown[];
  return data.map(deserializeFileEntry);
}

// ---------------------------------------------------------------------------
// searchFileContent — GET /api/files/search-content?q=...
// ---------------------------------------------------------------------------

export async function searchFileContent(
  query: string,
): Promise<ContentSearchResult[]> {
  const response = await fetch(
    `/api/files/search-content?q=${encodeURIComponent(query)}`,
  );
  if (!response.ok) throw new Error(`Failed to search content: ${response.status}`);
  const data = (await response.json()) as unknown[];
  return data.map((item) => {
    const obj = item as Record<string, unknown>;
    return {
      path: String(obj.path ?? ""),
      name: String(obj.name ?? ""),
      line: Number(obj.line ?? 0),
      content: String(obj.content ?? ""),
    };
  });
}

// ---------------------------------------------------------------------------
// Deserializer
// ---------------------------------------------------------------------------

function deserializeFileEntry(raw: unknown): FileEntry {
  const obj = raw as Record<string, unknown>;
  return {
    path: String(obj.path ?? ""),
    name: String(obj.name ?? ""),
    size: Number(obj.size ?? 0),
    isDir: Boolean(obj.isDir),
    modified: obj.modified ? String(obj.modified) : undefined,
  };
}
