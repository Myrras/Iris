/**
 * Iris brand mark, drawn in `currentColor`: a rainbow of two bands over a
 * core (Iris, the gods' messenger, travelled on the rainbow; the arch also
 * reads as a passage between two sides). Same 100×100 grid, opacity steps
 * and soft shadow as the Podium and Selene marks. The source of truth is
 * `src-tauri/icons/source/iris-mark.svg` (the app icon: `iris.svg`).
 */

import type { SVGProps } from "react";

interface LogoMarkProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

/** The mark's paths, outer band first (shared with tests). */
export const LOGO_PATHS = [
  "M6 76V64A44 44 0 0 1 94 64V76H84V64A34 34 0 0 0 16 64V76Z",
  "M20 76V64A30 30 0 0 1 80 64V76H70V64A20 20 0 0 0 30 64V76Z",
  "M34 76V64A16 16 0 0 1 66 64V76Z",
] as const;

const OPACITY = [0.45, 0.72, 1] as const;

export function LogoMark({ size = 18, ...props }: LogoMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      {...props}
    >
      <defs>
        <filter id="lm-shadow" x="-40%" y="-20%" width="180%" height="140%">
          <feDropShadow
            dx="0"
            dy="2"
            stdDeviation="3"
            floodColor="currentColor"
            floodOpacity="0.18"
          />
        </filter>
      </defs>
      <g fill="currentColor" filter="url(#lm-shadow)">
        {LOGO_PATHS.map((d, i) => (
          <path key={d} d={d} opacity={OPACITY[i]} />
        ))}
      </g>
    </svg>
  );
}
