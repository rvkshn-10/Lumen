export type Appearance = "system" | "light" | "dark";

const storageKey = "lumen-appearance";

export function readAppearance(): Appearance {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // The current appearance still works when storage is unavailable.
  }
  return "system";
}

export function applyAppearance(appearance: Appearance) {
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    document.documentElement.dataset.appearance = appearance === "system"
      ? (system.matches ? "dark" : "light")
      : appearance;
  };
  update();
  if (appearance === "system") system.addEventListener("change", update);

  try {
    if (appearance === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, appearance);
  } catch {
    // The current appearance still works when storage is unavailable.
  }

  return () => system.removeEventListener("change", update);
}
