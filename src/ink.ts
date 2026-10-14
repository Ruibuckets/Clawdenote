import type { Point, StrokeItem } from './model';

export type InkPathCommand =
  | { type: 'move' | 'line'; x: number; y: number }
  | { type: 'cubic'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'close' };
export interface StrokeBounds { x: number; y: number; w: number; h: number }

interface Geometry {
  samples: readonly Point[];
  path: readonly InkPathCommand[];
  bounds: StrokeBounds;
}
interface CachedGeometry {
  points: Point[];
  count: number;
  lastX: number;
  lastY: number;
  lastPressure: number;
  firstX: number;
  firstY: number;
  firstPressure: number;
  smoothing: number;
  width: number;
  tool: StrokeItem['tool'];
  geometry: Geometry;
}
const cache = new WeakMap<StrokeItem, CachedGeometry>();
const EPSILON = 0.00001;
const FLATNESS = 0.12;

function clamp(value: number, low = 0, high = 1): number { return Math.max(low, Math.min(high, value)); }
function smoothingFor(stroke: StrokeItem): number {
  const value = stroke.smoothing;
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : 0.55;
}
export function strokeRadius(stroke: StrokeItem, point: Point): number {
  const pressure = Number.isFinite(point.pressure) ? clamp(point.pressure) : 0.5;
  return stroke.width * (stroke.tool === 'highlighter' ? 1 : 0.25 + pressure * 1.5) / 2;
}
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t };
}
function direction(a: Point, b: Point): { x: number; y: number } {
  const length = distance(a, b);
  return length > EPSILON ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : { x: 1, y: 0 };
}

/** Sampling gaps vary with tablet frequency and pointer speed. Use local spacing. */
function sampleSpacing(points: readonly Point[]): number[] {
  const lengths = points.slice(1).map((point, index) => distance(point, points[index]));
  return points.map((_, index) => {
    const nearby = lengths.slice(Math.max(0, index - 3), Math.min(lengths.length, index + 3)).filter(length => length > EPSILON).sort((a, b) => a - b);
    return nearby.length ? nearby[Math.floor(nearby.length / 2)] : 0;
  });
}

/** Anchors genuine corners using context wider than one potentially noisy sample. */
function cornersFor(points: readonly Point[], spacing: readonly number[], strength: number): boolean[] {
  const corners = points.map(() => false);
  for (let i = 1; i < points.length - 1; i++) {
    // With only a few samples there is no wider evidence of jitter. Preserve
    // explicit V/L/N turns instead of guessing away the user's intended shape.
    if (points.length <= 4) {
      const incoming = direction(points[i - 1], points[i]);
      const outgoing = direction(points[i], points[i + 1]);
      corners[i] = incoming.x * outgoing.x + incoming.y * outgoing.y < 0.5;
      continue;
    }
    const reach = Math.max(5 + strength * 5, spacing[i] * (1.25 + strength));
    let previous = i - 1, next = i + 1;
    while (previous > 0 && distance(points[i], points[previous]) < reach) previous--;
    while (next < points.length - 1 && distance(points[i], points[next]) < reach) next++;
    const incomingLength = distance(points[previous], points[i]);
    const outgoingLength = distance(points[i], points[next]);
    if (incomingLength < 3 || outgoingLength < 3) continue;
    const incoming = direction(points[previous], points[i]);
    const outgoing = direction(points[i], points[next]);
    // Keep turns of sixty degrees or more. Tiny alternations along a straight
    // line do not become anchors merely because adjacent points zigzag.
    corners[i] = incoming.x * outgoing.x + incoming.y * outgoing.y < 0.5;
  }
  return corners;
}

function stabilize(points: readonly Point[], corners: readonly boolean[], spacing: readonly number[], strength: number): Point[] {
  return points.map((point, index) => {
    const positionReach = Math.max(4 + strength * 10, spacing[index] * (1.5 + strength * 1.5));
    const pressureReach = Math.max(4 + strength * 12, spacing[index] * (1.5 + strength * 1.5));
    let sumX = point.x, sumY = point.y, positionWeight = 1;
    let sumPressure = point.pressure, pressureWeight = 1;
    for (const direction of [-1, 1]) {
      let traveled = 0;
      for (let neighbor = index + direction; neighbor >= 0 && neighbor < points.length && Math.abs(neighbor - index) <= 24; neighbor += direction) {
        traveled += distance(points[neighbor], points[neighbor - direction]);
        if (traveled > Math.max(positionReach, pressureReach)) break;
        if (traveled <= positionReach) {
          const weight = Math.exp(-2 * (traveled / positionReach) ** 2);
          sumX += points[neighbor].x * weight; sumY += points[neighbor].y * weight; positionWeight += weight;
        }
        if (traveled <= pressureReach) {
          const weight = Math.exp(-2 * (traveled / pressureReach) ** 2);
          sumPressure += points[neighbor].pressure * weight; pressureWeight += weight;
        }
        if (corners[neighbor]) break;
      }
    }
    const pinned = index === 0 || index === points.length - 1 || corners[index];
    const amount = pinned ? 0 : strength;
    return {
      x: point.x + (sumX / positionWeight - point.x) * amount,
      y: point.y + (sumY / positionWeight - point.y) * amount,
      pressure: clamp(point.pressure + (sumPressure / pressureWeight - point.pressure) * strength * 0.85),
    };
  });
}

function perpendicularDistance(point: Point, a: Point, b: Point): number {
  const length = distance(a, b);
  return length > EPSILON ? Math.abs((b.x - a.x) * (a.y - point.y) - (a.x - point.x) * (b.y - a.y)) / length : distance(point, a);
}

/** Adaptive de Casteljau subdivision keeps even tightly curved strokes below 0.12 px error. */
function flattenCubic(a: Point, b: Point, c: Point, d: Point, output: Point[], depth = 0): void {
  const chord = distance(a, d);
  const polygonLength = distance(a, b) + distance(b, c) + distance(c, d);
  const flat = Math.max(perpendicularDistance(b, a, d), perpendicularDistance(c, a, d)) <= FLATNESS;
  if (depth >= 12 || (flat && polygonLength - chord <= FLATNESS && chord <= 4)) {
    output.push(d);
    return;
  }
  const ab = mix(a, b, 0.5), bc = mix(b, c, 0.5), cd = mix(c, d, 0.5);
  const abc = mix(ab, bc, 0.5), bcd = mix(bc, cd, 0.5), middle = mix(abc, bcd, 0.5);
  flattenCubic(a, ab, abc, middle, output, depth + 1);
  flattenCubic(middle, bcd, cd, d, output, depth + 1);
}

function smoothSamples(stroke: StrokeItem, strength: number): Point[] {
  const raw: Point[] = stroke.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)).map(point => ({
    x: point.x, y: point.y, pressure: Number.isFinite(point.pressure) ? clamp(point.pressure) : 0.5,
  }));
  // The off setting retains every raw position and pressure. Dots and simple
  // two-point lines need no filtering, and remain exactly where they were drawn.
  if (strength === 0 || raw.length <= 2) return raw;
  const unique: Point[] = [];
  for (const point of raw) {
    const previous = unique.at(-1);
    if (previous && distance(previous, point) < EPSILON) previous.pressure = Math.max(previous.pressure, point.pressure);
    else unique.push(point);
  }
  if (unique.length <= 2) return unique;
  const spacing = sampleSpacing(unique);
  const corners = cornersFor(unique, spacing, strength);
  const controls = stabilize(unique, corners, spacing, strength);
  const samples: Point[] = [{ ...controls[0] }];
  for (let i = 0; i < controls.length - 1; i++) {
    const a = controls[i], d = controls[i + 1];
    const length = distance(a, d);
    if (length < EPSILON) continue;
    const segment = direction(a, d);
    const incoming = i > 0 && !corners[i] ? direction(controls[i - 1], a) : segment;
    const outgoing = i + 2 < controls.length && !corners[i + 1] ? direction(d, controls[i + 2]) : segment;
    const b: Point = { x: a.x + (incoming.x + segment.x) * length / 6, y: a.y + (incoming.y + segment.y) * length / 6, pressure: a.pressure + (d.pressure - a.pressure) / 3 };
    const c: Point = { x: d.x - (segment.x + outgoing.x) * length / 6, y: d.y - (segment.y + outgoing.y) * length / 6, pressure: a.pressure + (d.pressure - a.pressure) * 2 / 3 };
    flattenCubic(a, b, c, d, samples);
  }
  return samples;
}

function appendArc(path: InkPathCommand[], center: Point, radius: number, angle: number, sweep: number): void {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const increment = sweep / pieces;
  for (let i = 0; i < pieces; i++) {
    const end = angle + increment;
    const k = 4 / 3 * Math.tan(increment / 4);
    const cosA = Math.cos(angle), sinA = Math.sin(angle), cosB = Math.cos(end), sinB = Math.sin(end);
    path.push({
      type: 'cubic',
      x1: center.x + radius * (cosA - k * sinA), y1: center.y + radius * (sinA + k * cosA),
      x2: center.x + radius * (cosB + k * sinB), y2: center.y + radius * (sinB - k * cosB),
      x: center.x + radius * cosB, y: center.y + radius * sinB,
    });
    angle = end;
  }
}

function appendDot(path: InkPathCommand[], point: Point, radius: number): void {
  path.push({ type: 'move', x: point.x + radius, y: point.y });
  // All contours use the same winding, including dots at abrupt pressure changes.
  appendArc(path, point, radius, 0, -Math.PI * 2);
  path.push({ type: 'close' });
}

function outlinePath(stroke: StrokeItem, samples: readonly Point[]): InkPathCommand[] {
  const path: InkPathCommand[] = [];
  const points: Point[] = [];
  for (const sample of samples) {
    const previous = points.at(-1);
    if (previous && distance(previous, sample) < EPSILON) previous.pressure = Math.max(previous.pressure, sample.pressure);
    else points.push({ ...sample });
  }
  if (!points.length) return path;
  if (points.length === 1) { appendDot(path, points[0], strokeRadius(stroke, points[0])); return path; }
  const directions = points.slice(1).map((point, index) => direction(points[index], point));
  const radii = points.map(point => strokeRadius(stroke, point));
  const split = [0];
  for (let i = 1; i < points.length - 1; i++) {
    const before = directions[i - 1], after = directions[i];
    const dot = before.x * after.x + before.y * after.y;
    const turn = Math.abs(Math.atan2(before.x * after.y - before.y * after.x, dot));
    const span = (distance(points[i - 1], points[i]) + distance(points[i], points[i + 1])) / 2;
    // An offset ribbon folds when nib radius exceeds local curve radius. Capped
    // pieces keep tight loops/reversals solid instead of introducing a false hole.
    if (dot < -0.8 || turn * radii[i] > span * 0.8) split.push(i);
  }
  split.push(points.length - 1);
  const offset = (index: number, side: number, tangent: { x: number; y: number }) => ({ x: points[index].x - tangent.y * side * radii[index], y: points[index].y + tangent.x * side * radii[index] });
  const lineTo = (point: { x: number; y: number }) => path.push({ type: 'line', x: point.x, y: point.y });
  function join(index: number, side: number, reverse: boolean): void {
    const before = directions[index - 1], after = directions[index];
    const dot = before.x * after.x + before.y * after.y;
    const cross = before.x * after.y - before.y * after.x;
    if (cross * side < -EPSILON) {
      const start = reverse ? after : before;
      lineTo(offset(index, side, start));
      appendArc(path, points[index], radii[index], Math.atan2(start.x * side, -start.y * side), Math.atan2(cross, dot) * (reverse ? -1 : 1));
    } else {
      const denominator = 1 + dot;
      const nx = -(before.y + after.y) * side, ny = (before.x + after.x) * side;
      const factor = denominator > EPSILON ? Math.min(radii[index] / denominator, radii[index] * 2 / Math.max(EPSILON, Math.hypot(nx, ny))) : 0;
      lineTo({ x: points[index].x + nx * factor, y: points[index].y + ny * factor });
    }
  }
  for (let piece = 1; piece < split.length; piece++) {
    const first = split[piece - 1], last = split[piece];
    const start = offset(first, 1, directions[first]);
    path.push({ type: 'move', ...start });
    for (let i = first + 1; i < last; i++) join(i, 1, false);
    lineTo(offset(last, 1, directions[last - 1]));
    appendArc(path, points[last], radii[last], Math.atan2(directions[last - 1].x, -directions[last - 1].y), -Math.PI);
    for (let i = last - 1; i > first; i--) join(i, -1, true);
    lineTo(offset(first, -1, directions[first]));
    appendArc(path, points[first], radii[first], Math.atan2(-directions[first].x, directions[first].y), -Math.PI);
    path.push({ type: 'close' });
  }
  // A near-stationary pressure change can make one nib circle enclose a whole
  // neighboring segment. Include that circle rather than letting a ribbon fold.
  for (let i = 0; i < points.length; i++) {
    const previous = i > 0 && radii[i] - radii[i - 1] > distance(points[i], points[i - 1]) * 0.45;
    const next = i + 1 < points.length && radii[i] - radii[i + 1] > distance(points[i], points[i + 1]) * 0.45;
    if (previous || next) appendDot(path, points[i], radii[i]);
  }
  return path;
}

function pathBounds(path: readonly InkPathCommand[]): StrokeBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let x = 0, y = 0;
  const include = (px: number, py: number) => { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); };
  const roots = (a: number, b: number, c: number, d: number): number[] => {
    const qa = -a + 3 * b - 3 * c + d, qb = 2 * (a - 2 * b + c), qc = b - a;
    if (Math.abs(qa) < EPSILON) return Math.abs(qb) < EPSILON ? [] : [-qc / qb];
    const discriminant = qb * qb - 4 * qa * qc;
    if (discriminant < 0) return [];
    const root = Math.sqrt(discriminant);
    return [(-qb + root) / (2 * qa), (-qb - root) / (2 * qa)];
  };
  const coordinate = (a: number, b: number, c: number, d: number, t: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
  for (const command of path) {
    if (command.type === 'close') continue;
    include(command.x, command.y);
    if (command.type === 'cubic') {
      const extrema = [...roots(x, command.x1, command.x2, command.x), ...roots(y, command.y1, command.y2, command.y)];
      for (const t of extrema) if (t > 0 && t < 1) include(coordinate(x, command.x1, command.x2, command.x, t), coordinate(y, command.y1, command.y2, command.y, t));
    }
    x = command.x; y = command.y;
  }
  return minX === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function geometryFor(stroke: StrokeItem): Geometry {
  const strength = smoothingFor(stroke);
  const first = stroke.points[0], last = stroke.points.at(-1);
  const previous = cache.get(stroke);
  if (previous && previous.points === stroke.points && previous.count === stroke.points.length &&
    previous.lastX === last?.x && previous.lastY === last?.y && previous.lastPressure === last?.pressure &&
    previous.firstX === first?.x && previous.firstY === first?.y && previous.firstPressure === first?.pressure &&
    previous.width === stroke.width && previous.tool === stroke.tool && previous.smoothing === strength) return previous.geometry;
  const samples = smoothSamples(stroke, strength);
  const path = outlinePath(stroke, samples);
  const geometry = { samples, path, bounds: pathBounds(path) };
  cache.set(stroke, {
    points: stroke.points, count: stroke.points.length,
    lastX: last?.x ?? NaN, lastY: last?.y ?? NaN, lastPressure: last?.pressure ?? NaN,
    firstX: first?.x ?? NaN, firstY: first?.y ?? NaN, firstPressure: first?.pressure ?? NaN,
    width: stroke.width, tool: stroke.tool, smoothing: strength, geometry,
  });
  return geometry;
}

/** These derived samples never replace or mutate the notebook's raw input points. */
export function getStrokeSamples(stroke: StrokeItem): readonly Point[] { return geometryFor(stroke).samples; }
/** Replay this path in Canvas, SVG, or MuPDF and fill once with the nonzero rule. */
export function getStrokePath(stroke: StrokeItem): readonly InkPathCommand[] { return geometryFor(stroke).path; }
export function getStrokeBounds(stroke: StrokeItem): StrokeBounds { return geometryFor(stroke).bounds; }
