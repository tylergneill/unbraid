/**
 * The Unbraid mark: voices entering tangled and leaving as separate parts.
 *
 * Drawn in the band colours from `bandPainter.ts` rather than a single fill, so
 * the identity and the interface share one palette. That is also why the SVG is
 * inlined instead of loaded from `src/imgs/logo-mark.svg` through an <img>,
 * which would flatten it. (`logo-mark.svg` keeps a one-colour currentColor copy
 * for anywhere that needs one.)
 *
 * `src/imgs/favicon.svg` is the same braid redrawn for small sizes — heavier
 * strokes, bigger nodes, less margin — so the tab icon and this agree. Change
 * the geometry here and it needs regenerating there too.
 */

interface Props {
  /** Rendered size in pixels. */
  size?: number;
  className?: string;
}

/*
 * The first four BAND_COLORS from bandPainter.ts, in that order — the colours an
 * SATB score's four voices actually get. The mark's strands exit top to bottom
 * in the same order, so the logo shows the same four colours as the bands below
 * it. Keep in step with BAND_COLORS.
 */
const BLUE = '#6aa9ff';
const GOLD = '#ffcb6b';
const GREEN = '#7fd88f';
const SALMON = '#ff9a76';

/**
 * The mark is drawn on the same 512 grid as the exported SVGs, then cropped by
 * viewBox to the artwork's real bounds — the square has wide margins that would
 * otherwise render it small and off-centre.
 */
const FULL_VIEW = { x: 18, y: 133, w: 410, h: 274 };

/** Four strands weaving on the left, resolving into four nodes on the right. */
function FullMark() {
  return (
    <>
      <path
        d="M34 310 C68 310 68 230 102 230 C135 230 135 150 169 150 C207 150 207 150 244 150 C298 150 298 150 352 150"
        fill="none"
        stroke={BLUE}
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M34 150 C68 150 68 230 102 230 C135 230 135 310 169 310 C207 310 207 230 244 230 C298 230 298 230 352 230"
        fill="none"
        stroke={GOLD}
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M34 390 C68 390 68 310 102 310 C135 310 135 230 169 230 C207 230 207 310 244 310 C298 310 298 310 352 310"
        fill="none"
        stroke={GREEN}
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M34 230 C68 230 68 310 102 310 C135 310 135 390 169 390 C207 390 207 390 244 390 C298 390 298 390 352 390"
        fill="none"
        stroke={SALMON}
        strokeWidth="26"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="378" y="127" width="46" height="46" rx="14" fill={BLUE} />
      <rect x="378" y="207" width="46" height="46" rx="14" fill={GOLD} />
      <rect x="378" y="287" width="46" height="46" rx="14" fill={GREEN} />
      <rect x="378" y="367" width="46" height="46" rx="14" fill={SALMON} />
    </>
  );
}

export function Logo({ size = 24, className }: Props) {
  return (
    <svg
      className={className}
      viewBox={`${FULL_VIEW.x} ${FULL_VIEW.y} ${FULL_VIEW.w} ${FULL_VIEW.h}`}
      width={size}
      height={size * (FULL_VIEW.h / FULL_VIEW.w)}
      role="img"
      aria-label="Unbraid"
    >
      <FullMark />
    </svg>
  );
}
