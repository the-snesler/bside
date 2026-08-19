import { render } from "preact";
import "@/styles/theme.css";
import "./style.css";
import { App } from "./App";

const root = document.getElementById("app");
if (!root) throw new Error("options: missing #app mount node");

render(<App />, root);
