import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// UI 冒烟测试入口：浏览器中带 ?e2e-mock=1 时加载 IPC 假实现，再挂载应用。
async function bootstrap() {
  if (new URLSearchParams(window.location.search).has("e2e-mock")) {
    await import("./dev-mock");
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
