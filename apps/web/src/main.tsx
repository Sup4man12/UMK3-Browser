import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlayPage } from "./pages/PlayPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlayPage />
  </StrictMode>,
);
