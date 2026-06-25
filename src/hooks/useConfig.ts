import { useConfigContext } from "../contexts/ConfigContext";

export function useConfig() {
  const { config, isConfigured, isLoading, saveConfig, logout } = useConfigContext();
  return { config, isConfigured, isLoading, saveConfig, logout };
}
