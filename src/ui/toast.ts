import { bus } from "../state";
import { $ } from "../utils";

let timer: ReturnType<typeof setTimeout> | undefined;

export function initToast(): void {
  const el = $("toast");
  bus.on("toast", (message) => {
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), 2600);
  });
}
