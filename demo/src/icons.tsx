// Inline line icons (24px grid, currentColor) for the journey and section headers.
const PATHS = {
  data: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  spectra: "M3 18c3 0 3.5-9 6-9s3 6 5 6 3-11 7-11",
  composition: "M4 20V10m5 10V4m5 16v-7m5 7V8",
  table: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-3.5v-1",
  diagnosis: "M9 11l2.5 2.5L16 9M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z",
  flow: "M4 6h16M7 12h10M10 18h4",
  structure: "M5 19 19 5M7 9h.01M10 14h.01M15 8h.01M16 15h.01M12 11h.01",
  repeat: "M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5",
  evidence: "M14 3H6v18h12V7l-4-4Zm0 0v4h4M9 12h6M9 16h6",
  capability: "M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.8L12 3Z",
  export: "M12 4v11m0 0-4-4m4 4 4-4M5 19h14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="icon">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
