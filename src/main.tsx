import React from "react";
import ReactDOM from "react-dom/client";

// UI 冒烟测试入口：浏览器中带 ?e2e-mock=1 时加载 IPC 假实现，再挂载应用。
async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("e2e-mock")) {
    await import("./dev-mock");
  }
  // 视频控件不加载工作区全局布局，也不启动登录、文件列表和 AI 等无关业务。
  const RootComponent = params.has("player")
    ? (await import("./components/PlayerControls")).PlayerControls
    : (await import("./App")).default;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RootComponent />
    </React.StrictMode>,
  );
}

void bootstrap();
