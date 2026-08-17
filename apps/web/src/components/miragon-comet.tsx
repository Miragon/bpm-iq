import { COMET_COLOR, COMET_PATH, COMET_VIEW_BOX } from "@/lib/comet";

/** The Miragon comet in the app header — geometry and colour live in lib/comet. */
export function MiragonComet({ className }: { className?: string }) {
  return (
    <svg
      viewBox={COMET_VIEW_BOX}
      className={className}
      fill={COMET_COLOR}
      role="presentation"
      focusable="false"
      aria-hidden="true"
    >
      <path d={COMET_PATH} />
    </svg>
  );
}
