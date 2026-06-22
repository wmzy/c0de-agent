import { css } from "@linaria/core";

const appClass = css`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100dvh;
  font-family: system-ui, sans-serif;
  color: #e6edf3;
  background: #0d1117;
`;

export function App() {
  return (
    <div className={appClass}>
      <h1>c0de-agent</h1>
    </div>
  );
}
