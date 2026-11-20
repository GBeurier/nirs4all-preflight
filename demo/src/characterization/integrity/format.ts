import { formatEngineNumber } from "nirs4all-ui/qualification";
import type { Locale } from "nirs4all-ui/lab";

/** Number formatter: integers exactly, others with `digits` significant digits; "—" for non-finite. */
export const makeFmt = (locale: Locale) => (v: number, digits = 3): string =>
  !Number.isFinite(v) ? "—" : Number.isInteger(v) && Math.abs(v) < 1e15 ? v.toLocaleString(locale) : (formatEngineNumber(v, locale, digits) ?? "—");
