import { render } from "preact";
import "@/styles/theme.css";
import "@/styles/welcome.css";
import { App } from "./App";

render(<App />, document.getElementById("app")!);
