import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "nirs4all-ui/assets/theme.css";
import "nirs4all-ui/assets/viz.css";
import "nirs4all-ui/assets/qualification.css";
import "./styles.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
