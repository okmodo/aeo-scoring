import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ReportDesign } from "./report-design/ReportDesign";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {["/report-design", "/report-design/"].includes(window.location.pathname) ? <ReportDesign /> : <App />}
  </React.StrictMode>,
);
