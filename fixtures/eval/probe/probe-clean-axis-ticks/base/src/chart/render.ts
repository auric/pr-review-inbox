export type Svg = string[];

export function axisLine(width: number, y: number): Svg {
  return [`<line x1="0" y1="${y}" x2="${width}" y2="${y}" />`];
}
