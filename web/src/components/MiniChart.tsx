import { useState } from "react";

interface Props {
  values: number[];
  labels: string[];
  /** CSS custom property holding the series colour, e.g. "--series-1". */
  colorVar: string;
  /** Accessible name; the surrounding card's heading names the series. */
  title: string;
  formatValue?: (n: number) => string;
}

/**
 * A seven-day bar chart in about eighty lines of SVG.
 *
 * Bars rather than a line: these are discrete daily counts, not a continuous
 * quantity, and a bar makes "nothing happened on Tuesday" visible as zero
 * height instead of a line sagging through it.
 *
 * One series per chart, so there is no legend — the card's heading names it —
 * and only the peak is labelled directly, because a number on every bar is
 * noise at this size. A table view lives underneath for screen readers.
 */
export function MiniChart({ values, labels, colorVar, title, formatValue = String }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  // The viewBox is in *approximately real pixels* and the SVG scales
  // uniformly. An earlier version used a 100-unit box with
  // preserveAspectRatio="none", which stretched every horizontal measurement by
  // the width of the card: a bar capped at "half its slot" came out ~50px wide
  // and the chart read as a row of slabs. Uniform scaling is what keeps a thin
  // mark thin.
  const width = 640;
  const height = 108;
  const gap = 2; // the 2px surface gap between adjacent bars
  const slot = width / Math.max(values.length, 1);
  const barWidth = Math.max(Math.min(slot - gap * 2, 22), 2);
  const max = Math.max(...values, 1);
  // -1 when every value is zero: Math.max floors at 1 for the scale.
  const peak = values.indexOf(max);

  return (
    <div className="miniChart" style={{ ["--series" as string]: `var(${colorVar})` }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {/* A single recessive baseline; no gridlines at this size. */}
        <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} className="miniChart__axis" />

        {values.map((value, i) => {
          const h = Math.max((value / max) * (height - 14), value > 0 ? 3 : 0);
          const x = i * slot + (slot - barWidth) / 2;
          return (
            <g key={i}>
              <rect
                x={x}
                y={height - h}
                width={barWidth}
                height={h}
                rx="4"
                className={hover === i ? "miniChart__bar miniChart__bar--on" : "miniChart__bar"}
              />
              {/* An invisible full-height target, so the hit area is bigger
                  than a two-pixel bar. */}
              <rect
                x={i * slot}
                y="0"
                width={slot}
                height={height}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>

      <div className="miniChart__labels">
        {labels.map((label, i) => (
          <span key={i} className={i === hover ? "on" : ""}>
            {label}
          </span>
        ))}
      </div>

      <p className="miniChart__peak">
        {/* With nothing recorded all week there is no peak to name: `max` is
            floored at 1 for the scale, so labels[indexOf(max)] was undefined
            and the line read "· 1" — a number that appears nowhere. */}
        {hover !== null
          ? `${labels[hover]} · ${formatValue(values[hover] ?? 0)}`
          : peak >= 0
            ? `${labels[peak] ?? ""} · ${formatValue(max)}`
            : formatValue(0)}
      </p>

      {/* The table view: the same numbers, reachable without seeing the chart. */}
      <table className="visually-hidden">
        <caption>{title}</caption>
        <tbody>
          {values.map((value, i) => (
            <tr key={i}>
              <th scope="row">{labels[i]}</th>
              <td>{formatValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
