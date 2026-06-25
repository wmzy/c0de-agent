import React from "react";

type ErrorBoundaryProps = {
  children: React.ReactNode;
  fallback?: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2>出错了</h2>
          <p style={{ color: "var(--haze-color-text-secondary, #8b949e)", marginTop: "0.5rem" }}>
            {this.state.error?.message ?? "发生了一个意外错误"}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              cursor: "pointer",
              borderRadius: "4px",
              border: "1px solid var(--haze-color-border, #30363d)",
              background: "var(--haze-color-bg-subtle, #161b22)",
            }}
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
