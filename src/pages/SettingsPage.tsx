import { css } from "@linaria/core";
import { Button, Card, Divider, Input, Option, Select, Spinner, Switch } from "haze-ui";
import { type ThemeMode, resolveThemeClass } from "../utils/theme";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MCPServerConfig } from "../core/types";
import { useConfig } from "../hooks/useConfig";
import { toast } from "../utils/toast";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const page = css`
  max-width: 560px;
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

const sectionTitle = css`
  font-size: 14px;
  font-weight: 600;
  color: var(--haze-color-text);
  margin-bottom: 16px;
`;

const sectionGroup = css`
  margin-bottom: 20px;
`;

const row = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
`;

const rowInfo = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const rowLabel = css`
  font-size: 14px;
  font-weight: 500;
  color: var(--haze-color-text);
`;

const rowDesc = css`
  font-size: 12px;
  color: var(--haze-color-text-muted);
`;

const toolList = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
`;

const toolItem = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--haze-radius-md);
  background: var(--haze-color-bg-secondary);
`;

const toolInfo = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
`;

const toolName = css`
  font-size: 14px;
  font-weight: 500;
  color: var(--haze-color-text);
`;

const toolDesc = css`
  font-size: 12px;
  color: var(--haze-color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const section = css`
  margin-bottom: 24px;
`;

const formGroup = css`
  margin-bottom: 16px;
`;

const label = css`
  display: block;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--haze-color-text);
`;

const mcpList = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
`;

const mcpItem = css`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px;
  border-radius: var(--haze-radius-md);
  background: var(--haze-color-bg-secondary);
  gap: 12px;
`;

const mcpItemInfo = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
`;

const mcpItemName = css`
  font-size: 14px;
  font-weight: 500;
  color: var(--haze-color-text);
`;

const mcpItemDetail = css`
  font-size: 12px;
  color: var(--haze-color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const mcpForm = css`
  padding: 12px;
  border-radius: var(--haze-radius-md);
  background: var(--haze-color-bg-secondary);
  margin-bottom: 16px;
`;

const mcpFormRow = css`
  display: flex;
  gap: 12px;
  margin-bottom: 12px;

  & > * {
    flex: 1;
  }
`;

const addMcpButton = css`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px;
  border: 1px dashed var(--haze-color-border);
  border-radius: var(--haze-radius-md);
  background: transparent;
  color: var(--haze-color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    border-color: var(--haze-color-accent);
    color: var(--haze-color-accent);
  }
`;

const removeButton = css`
  padding: 4px 8px;
  border: none;
  border-radius: var(--haze-radius-sm);
  background: transparent;
  color: var(--haze-color-text-muted);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--haze-color-error-bg);
    color: var(--haze-color-error);
  }
`;

const emptyMcp = css`
  padding: 16px 0;
  text-align: center;
  color: var(--haze-color-text-muted);
  font-size: 14px;
`;

const presets = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "SenseNova (商汤)", baseUrl: "https://token.sensenova.cn/v1", model: "sensenova-6.7-flash-lite" },
  { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  { name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:14b" },
  { name: "自定义", baseUrl: "", model: "" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const navigate = useNavigate();
  const { config, saveConfig } = useConfig();

  // Provider state
  const [presetIndex, setPresetIndex] = useState(0);
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? presets[0].baseUrl);
  const [model, setModel] = useState(config?.model ?? presets[0].model);
  const [isSaving, setIsSaving] = useState(false);

  // Appearance state
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("c0de-theme") as ThemeMode) || "system",
  );
  const [locale, setLocale] = useState(
    () => localStorage.getItem("c0de-locale") || "en",
  );

  // Tools state
  const [allTools, setAllTools] = useState<Array<{ name: string; description: string }>>([]);
  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>({});
  const [toolsLoading, setToolsLoading] = useState(true);

  // MCP server state
  const [mcpServers, setMcpServers] = useState<MCPServerConfig[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);

  // Plugin state
  const [plugins, setPlugins] = useState<Array<{ name: string; version: string; description: string }>>([]);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const [enabledPlugins, setEnabledPlugins] = useState<Record<string, boolean>>({});
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [newMcp, setNewMcp] = useState<MCPServerConfig>({
    name: "",
    transport: "stdio",
    command: "",
    args: [],
    url: "",
  });

  // Fetch available tools on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tools");
        if (!res.ok) return;
        const tools = (await res.json()) as Array<{
          name: string;
          description: string;
          parameters: unknown;
          permission: unknown;
        }>;
        if (cancelled) return;
        setAllTools(tools);
        // Restore persisted tool state; default all tools to enabled
        const saved = localStorage.getItem("c0de-tools");
        const initial: Record<string, boolean> = {};
        for (const t of tools) {
          const savedState = saved ? (JSON.parse(saved) as Record<string, boolean>) : null;
          initial[t.name] = savedState?.[t.name] ?? true;
        }
        setEnabledTools(initial);
      } catch {
        // Tools list is non-critical — silently degrade
      } finally {
        if (!cancelled) setToolsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch MCP servers from config on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) return;
        const data = (await res.json()) as { mcpServers?: MCPServerConfig[]; plugins?: { enabled?: string[] } };
        if (cancelled) return;
        setMcpServers(data.mcpServers ?? []);
        // Load plugin state
        const enabledSet = new Set(data.plugins?.enabled ?? []);
        setEnabledPlugins((prev) => {
          const next = { ...prev };
          for (const name of enabledSet) next[name] = true;
          return next;
        });
      } catch {
        // Non-critical
      } finally {
        if (!cancelled) setMcpLoading(false);
        if (!cancelled) setPluginsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  const handlePresetChange = useCallback((index: number) => {
    setPresetIndex(index);
    setBaseUrl(presets[index].baseUrl);
    setModel(presets[index].model);
  }, []);

  const applyTheme = useCallback((mode: ThemeMode) => {
    setTheme(mode);
    localStorage.setItem("c0de-theme", mode);
    // StorageEvent will notify App.tsx to update the theme class
  }, []);

  const handleLocaleChange = useCallback((newLocale: string) => {
    setLocale(newLocale);
    localStorage.setItem("c0de-locale", newLocale);
  }, []);

  const handleToolToggle = useCallback(
    (toolName: string) => {
      setEnabledTools((prev) => {
        const next = { ...prev, [toolName]: !prev[toolName] };
        localStorage.setItem("c0de-tools", JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  // MCP server handlers
  const handleAddMcpServer = useCallback(() => {
    if (!newMcp.name.trim()) {
      toast.error("请输入服务器名称");
      return;
    }
    if (newMcp.transport === "stdio" && !newMcp.command?.trim()) {
      toast.error("stdio 传输需要命令");
      return;
    }
    if ((newMcp.transport === "sse" || newMcp.transport === "http") && !newMcp.url?.trim()) {
      toast.error("SSE/HTTP 传输需要 URL");
      return;
    }
    if (mcpServers.some((s) => s.name === newMcp.name.trim())) {
      toast.error("服务器名称已存在");
      return;
    }
    const server: MCPServerConfig = {
      name: newMcp.name.trim(),
      transport: newMcp.transport,
      ...(newMcp.transport === "stdio"
        ? { command: newMcp.command?.trim(), args: newMcp.args?.filter(Boolean) }
        : { url: newMcp.url?.trim() }),
    };
    setMcpServers((prev) => [...prev, server]);
    setNewMcp({ name: "", transport: "stdio", command: "", args: [], url: "" });
    setShowMcpForm(false);
  }, [newMcp, mcpServers]);

  const handleRemoveMcpServer = useCallback((name: string) => {
    setMcpServers((prev) => prev.filter((s) => s.name !== name));
  }, []);

  // Plugin toggle handler
  const handlePluginToggle = useCallback((pluginName: string) => {
    setEnabledPlugins((prev) => ({ ...prev, [pluginName]: !(prev[pluginName] ?? true) }));
  }, []);

  const persistAdvancedSettings = useCallback(async () => {
    const enabled = allTools.filter((t) => enabledTools[t.name]).map((t) => t.name);
    const disabled = allTools.filter((t) => !enabledTools[t.name]).map((t) => t.name);
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, locale, tools: { enabled, disabled }, mcpServers }),
      });
    } catch {
      // Non-fatal — preferences are persisted locally
    }
  }, [allTools, enabledTools, theme, locale, mcpServers]);

  const handleSubmit = useCallback(async () => {
    if (!apiKey.trim()) {
      toast.error("请输入 API Key");
      return;
    }

    setIsSaving(true);
    try {
      await saveConfig({ apiKey, baseUrl, model });
      // Also persist appearance + tools
      await persistAdvancedSettings();
      toast.success("配置已保存");
      navigate("/chat");
    } catch {
      toast.error("保存失败，请重试");
    } finally {
      setIsSaving(false);
    }
  }, [apiKey, baseUrl, model, saveConfig, persistAdvancedSettings, navigate]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className={page}>
      <h1 className={title}>设置</h1>
      <p className={subtitle}>配置 Provider、外观和工具</p>

      {/* ---- Provider Config ---- */}
      <Card className={section}>
        <div className={sectionTitle}>Provider</div>

        <div className={formGroup}>
          <label className={label}>Provider 预设</label>
          <Select
            value={String(presetIndex)}
            onChange={(e) => handlePresetChange(Number(e.target.value))}
          >
            {presets.map((p, i) => (
              <Option key={i} value={String(i)}>
                {p.name}
              </Option>
            ))}
          </Select>
        </div>

        <div className={formGroup}>
          <label className={label}>API Key</label>
          <Input
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>

        <div className={formGroup}>
          <label className={label}>Base URL</label>
          <Input
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        <div className={formGroup}>
          <label className={label}>Model</label>
          <Input placeholder="gpt-4o" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </Card>

      {/* ---- Appearance ---- */}
      <Card className={section}>
        <div className={sectionTitle}>外观</div>

        <div className={sectionGroup}>
          <div className={row}>
            <div className={rowInfo}>
              <span className={rowLabel}>主题</span>
              <span className={rowDesc}>选择界面配色方案</span>
            </div>
            <Select
              value={theme}
              onChange={(e) => applyTheme(e.target.value as ThemeMode)}
              style={{ width: 140 }}
            >
              <Option value="light">浅色</Option>
              <Option value="dark">深色</Option>
              <Option value="system">跟随系统</Option>
            </Select>
          </div>
        </div>

        <Divider />

        <div className={sectionGroup}>
          <div className={row}>
            <div className={rowInfo}>
              <span className={rowLabel}>语言</span>
              <span className={rowDesc}>界面显示语言</span>
            </div>
            <Select
              value={locale}
              onChange={(e) => handleLocaleChange(e.target.value)}
              style={{ width: 140 }}
            >
              <Option value="en">English</Option>
              <Option value="zh">中文</Option>
            </Select>
          </div>
        </div>
      </Card>

      {/* ---- Tools ---- */}
      <Card className={section}>
        <div className={sectionTitle}>工具</div>

        {toolsLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <Spinner />
          </div>
        ) : allTools.length === 0 ? (
          <div style={{ padding: "16px 0", textAlign: "center", color: "var(--haze-color-text-muted)", fontSize: 14 }}>
            暂无可用工具
          </div>
        ) : (
          <div className={toolList}>
            {allTools.map((tool) => (
              <div key={tool.name} className={toolItem}>
                <div className={toolInfo}>
                  <span className={toolName}>{tool.name}</span>
                  <span className={toolDesc}>{tool.description}</span>
                </div>
                <Switch
                  checked={enabledTools[tool.name] ?? true}
                  onClick={() => handleToolToggle(tool.name)}
                  size="sm"
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---- MCP Servers ---- */}
      <Card className={section}>
        <div className={sectionTitle}>MCP 服务器</div>

        {mcpLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <Spinner />
          </div>
        ) : (
          <>
            {mcpServers.length > 0 ? (
              <div className={mcpList}>
                {mcpServers.map((server) => (
                  <div key={server.name} className={mcpItem}>
                    <div className={mcpItemInfo}>
                      <span className={mcpItemName}>{server.name}</span>
                      <span className={mcpItemDetail}>
                        {server.transport === "stdio"
                          ? `stdio · ${server.command ?? ""}${server.args?.length ? ` ${server.args.join(" ")}` : ""}`
                          : `${server.transport} · ${server.url ?? ""}`}
                      </span>
                    </div>
                    <button
                      className={removeButton}
                      onClick={() => handleRemoveMcpServer(server.name)}
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className={emptyMcp}>暂无 MCP 服务器</div>
            )}

            {showMcpForm ? (
              <div className={mcpForm}>
                <div className={mcpFormRow}>
                  <div className={formGroup} style={{ marginBottom: 0 }}>
                    <label className={label}>名称</label>
                    <Input
                      placeholder="my-server"
                      value={newMcp.name}
                      onChange={(e) => setNewMcp((p) => ({ ...p, name: e.target.value }))}
                    />
                  </div>
                  <div className={formGroup} style={{ marginBottom: 0 }}>
                    <label className={label}>传输方式</label>
                    <Select
                      value={newMcp.transport}
                      onChange={(e) =>
                        setNewMcp((p) => ({
                          ...p,
                          transport: e.target.value as MCPServerConfig["transport"],
                        }))
                      }
                    >
                      <Option value="stdio">stdio</Option>
                      <Option value="sse">SSE</Option>
                      <Option value="http">HTTP</Option>
                    </Select>
                  </div>
                </div>

                {newMcp.transport === "stdio" ? (
                  <>
                    <div className={formGroup}>
                      <label className={label}>命令</label>
                      <Input
                        placeholder="npx -y @modelcontextprotocol/server-filesystem"
                        value={newMcp.command ?? ""}
                        onChange={(e) => setNewMcp((p) => ({ ...p, command: e.target.value }))}
                      />
                    </div>
                    <div className={formGroup}>
                      <label className={label}>参数 (空格分隔)</label>
                      <Input
                        placeholder="/path/to/dir"
                        value={(newMcp.args ?? []).join(" ")}
                        onChange={(e) =>
                          setNewMcp((p) => ({
                            ...p,
                            args: e.target.value.split(" ").filter(Boolean),
                          }))
                        }
                      />
                    </div>
                  </>
                ) : (
                  <div className={formGroup}>
                    <label className={label}>URL</label>
                    <Input
                      placeholder="http://localhost:3001/sse"
                      value={newMcp.url ?? ""}
                      onChange={(e) => setNewMcp((p) => ({ ...p, url: e.target.value }))}
                    />
                  </div>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <Button onClick={handleAddMcpServer} size="sm">
                    添加
                  </Button>
                  <Button
                    onClick={() => {
                      setShowMcpForm(false);
                      setNewMcp({ name: "", transport: "stdio", command: "", args: [], url: "" });
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <button
                className={addMcpButton}
                onClick={() => setShowMcpForm(true)}
                type="button"
              >
                + 添加 MCP 服务器
              </button>
            )}
          </>
        )}
      </Card>

      {/* ---- Plugins ---- */}
      <Card className={section}>
        <div className={sectionTitle}>插件管理</div>
        {pluginsLoading ? (
          <div style={{ textAlign: "center", padding: 16 }}><Spinner size="sm" /></div>
        ) : (
          <>
            {plugins.length > 0 ? (
              plugins.map((plugin) => (
                <div key={plugin.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0" }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{plugin.name}</div>
                    <div style={{ fontSize: 12, color: "var(--haze-color-text-secondary)" }}>{plugin.version} — {plugin.description}</div>
                  </div>
                  <Switch
                    checked={enabledPlugins[plugin.name] ?? true}
                    onChange={() => handlePluginToggle(plugin.name)}
                  />
                </div>
              ))
            ) : (
              <div style={{ color: "var(--haze-color-text-secondary)", textAlign: "center", padding: 16 }}>暂无已安装插件</div>
            )}
          </>
        )}
      </Card>

      {/* ---- Save ---- */}
      <Button
        onClick={handleSubmit}
        disabled={isSaving || !apiKey.trim()}
        style={{ width: "100%" }}
      >
        {isSaving ? "保存中..." : "保存配置"}
      </Button>
    </div>
  );
}
