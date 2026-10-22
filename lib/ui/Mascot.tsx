/** What the face shows: still, reels spinning, looking up with a "!", or drooping. */
export type MascotMood = "idle" | "working" | "needs" | "failed";

const REEL_SPOKE = 3.3;
const round = (value: number) => Math.round(value * 10) / 10;

/** A tape-reel eye's hub: a round centre and four lobes on an X, which spins while bside works. */
function Reel(props: { cx: number; cy: number }) {
  const { cx, cy } = props;
  const lobes = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [round(cx + x! * REEL_SPOKE), round(cy + y! * REEL_SPOKE)] as const);
  return (
    <g class="mascot__reel" style={{ transformOrigin: `${cx}px ${cy}px` }}>
      <path class="mascot__spokes" d={`M${lobes[0]![0]} ${lobes[0]![1]}L${lobes[2]![0]} ${lobes[2]![1]}M${lobes[1]![0]} ${lobes[1]![1]}L${lobes[3]![0]} ${lobes[3]![1]}`} />
      <circle cx={cx} cy={cy} r="2.8" />
      {lobes.map(([x, y]) => <circle key={`${x},${y}`} cx={x} cy={y} r="2.1" />)}
    </g>
  );
}

/**
 * bside's face, a close-up of the cassette icon: two tape-reel eyes and a
 * smile. Decorative only (hidden from assistive technology), so callers state
 * the status in words. `size` is its height in pixels. `blink` adds an
 * occasional blink, for the one large face in an empty chat.
 */
export function Mascot(props: { mood: MascotMood; size: number; blink?: boolean }) {
  const { mood, size } = props;
  const eyeY = 18.6;
  const reelY = mood === "needs" ? eyeY - 2 : eyeY;
  return (
    <span class={props.blink ? "mascot mascot--blink" : "mascot"} data-mood={mood} style={{ "--mascot-size": `${size}px` }} aria-hidden="true">
      <svg class="mascot__face" viewBox="0 0 64 42">
        <rect class="mascot__body" width="64" height="42" rx="11" />
        <circle class="mascot__eye" cx="18.4" cy={eyeY} r="11.2" />
        <circle class="mascot__eye" cx="45.6" cy={eyeY} r="11.2" />
        <Reel cx={18.4} cy={reelY} />
        <Reel cx={45.6} cy={reelY} />
        {mood === "failed" && <path class="mascot__body" d="M5 5H31.5V14.2L5 17.6ZM32.5 5H59V17.6L32.5 14.2Z" />}
        {props.blink && (
          <>
            <rect class="mascot__body mascot__lid" x="6.8" y="7" width="23.2" height="23.4" />
            <rect class="mascot__body mascot__lid" x="34" y="7" width="23.2" height="23.4" />
          </>
        )}
        {mood === "needs" ? (
          <ellipse class="mascot__mouth-fill" cx="32" cy="34.2" rx="2.6" ry="2.9" />
        ) : (
          <path class="mascot__mouth" d={mood === "failed" ? "M27 35.6q5-3 10 0" : "M26.4 32.6q5.6 3.8 11.2 0"} />
        )}
      </svg>
    </span>
  );
}
