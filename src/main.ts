import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./style.css";
import { initSession } from "./cloud/session";
import { initBack } from "./ui/back";
import { initEntry, whenEntryOpens } from "./ui/entry";
import { initMenu } from "./ui/menu";
import { initNav } from "./ui/nav";
import { initSheets } from "./ui/sheets";
import { initTheme } from "./ui/theme";
import { initToast } from "./ui/toast";
import { initUpdate } from "./ui/update";
import { initTuner, stopTuner } from "./tuner/ui";

initBack();
initSheets();
initToast();
initEntry();
whenEntryOpens(stopTuner);
initTheme();
initMenu();
initTuner();
initNav(); // after the tuner, so it hears which section opens first
initUpdate();
initSession(); // last: its first auth event fills in the account
