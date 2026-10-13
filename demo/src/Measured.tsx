import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Renders a chart at its container's pixel width so SVG text keeps its nominal size on every screen. */
export function Measured({ children, min = 280 }: { children: (width: number) => ReactNode; min?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="measured">{width > 0 ? children(Math.max(min, width)) : null}</div>;
}
