import { darkTheme, lightTheme } from "haze-ui";

export type ThemeMode = "light" | "dark" | "system";

export function resolveThemeClass(mode: ThemeMode): string {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? darkTheme
      : lightTheme;
  }
  return mode === "dark" ? darkTheme : lightTheme;
}
