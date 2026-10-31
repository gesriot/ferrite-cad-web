export function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

export function parseNum(s: string): number | null {
  const n = Number(s.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Legacy documents store "мм" and "шт". Display is English; the stored code stays. */
export function displayUnit(unit: string | undefined): string {
  if (unit === "мм" || unit === "mm") return "mm";
  if (unit === "шт" || unit === "pcs" || unit === "count") return "Count";
  if (unit === "°" || unit === "deg") return "°";
  return unit ?? "";
}

export function isCountUnit(unit: string | undefined): boolean {
  return unit === "шт" || unit === "pcs" || unit === "count";
}

export function coerceParameterValue(unit: string | undefined, value: number): number {
  if (!isCountUnit(unit)) return value;
  return Math.max(1, Math.round(value));
}
