import { createId, type InkItem, type Point, type StrokeItem } from './model';
import { hitTest, itemBounds, type ItemBounds } from './drawing';
import { strokeRadius } from './ink';

export interface LassoPoint { x: number; y: number }
export interface LassoSelection { items: InkItem[]; selectedIds: string[] }
interface PolygonEdge { a: LassoPoint; b: LassoPoint; bounds: ItemBounds }
interface Polygon { points: readonly LassoPoint[]; edges: PolygonEdge[]; bounds: ItemBounds }
interface StrokeRun { inside: boolean; points: Point[] }
const EPSILON = 1e-7;

function sameItems(items: readonly InkItem[]): InkItem[] {
  // No helper mutates its inputs. Preserve reference identity on a no-op so the
  // live eraser can avoid unnecessary history entries and recovery writes.
  return items as InkItem[];
}
function finitePoint(point: LassoPoint): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y); }
function squaredDistance(a: LassoPoint, b: LassoPoint): number { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }
function cross(a: LassoPoint, b: LassoPoint): number { return a.x * b.y - a.y * b.x; }
function subtract(a: LassoPoint, b: LassoPoint): LassoPoint { return { x: a.x - b.x, y: a.y - b.y }; }
function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t };
}
function boundsOf(a: LassoPoint, b: LassoPoint, pad = 0): ItemBounds {
  return { x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad, w: Math.abs(a.x - b.x) + pad * 2, h: Math.abs(a.y - b.y) + pad * 2 };
}
function overlaps(a: ItemBounds, b: ItemBounds): boolean {
  return a.x <= b.x + b.w + EPSILON && a.x + a.w >= b.x - EPSILON && a.y <= b.y + b.h + EPSILON && a.y + a.h >= b.y - EPSILON;
}
function insideBounds(point: LassoPoint, bounds: ItemBounds): boolean {
  return point.x >= bounds.x - EPSILON && point.x <= bounds.x + bounds.w + EPSILON && point.y >= bounds.y - EPSILON && point.y <= bounds.y + bounds.h + EPSILON;
}
function rawStrokeBounds(stroke: StrokeItem, pad = 0): ItemBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  return minX === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

function preparePolygon(input: readonly LassoPoint[]): Polygon | null {
  const points: LassoPoint[] = [];
  for (const point of input) {
    if (!finitePoint(point)) return null;
    if (!points.length || squaredDistance(points.at(-1)!, point) > EPSILON ** 2) points.push(point);
  }
  if (points.length > 1 && squaredDistance(points[0], points.at(-1)!) <= EPSILON ** 2) points.pop();
  if (points.length < 3) return null;
  // A self-crossing lasso is valid; a line or repeated tap is not.
  const direction = subtract(points[1], points[0]);
  if (!points.some(point => Math.abs(cross(direction, subtract(point, points[0]))) > EPSILON)) return null;
  const edges = points.map((a, index): PolygonEdge => {
    const b = points[(index + 1) % points.length];
    return { a, b, bounds: boundsOf(a, b) };
  });
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { points, edges, bounds: { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY } };
}

function contains(point: LassoPoint, polygon: Polygon): boolean {
  if (!insideBounds(point, polygon.bounds)) return false;
  let inside = false;
  for (const { a, b, bounds } of polygon.edges) {
    const edge = subtract(b, a), offset = subtract(point, a);
    if (insideBounds(point, bounds) && Math.abs(cross(edge, offset)) <= EPSILON * Math.max(1, Math.hypot(edge.x, edge.y))) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Polygon boundary counts as inside; self-crossing lassos use the even/odd rule. */
export function pointInLasso(point: LassoPoint, polygon: readonly LassoPoint[]): boolean {
  const prepared = preparePolygon(polygon);
  return finitePoint(point) && prepared !== null && contains(point, prepared);
}

function uniqueCuts(values: number[]): number[] {
  const sorted = values.filter(value => Number.isFinite(value) && value >= -EPSILON && value <= 1 + EPSILON).map(value => Math.max(0, Math.min(1, value))).sort((a, b) => a - b);
  return sorted.filter((value, index) => index === 0 || value - sorted[index - 1] > EPSILON);
}
function polygonCuts(a: Point, b: Point, polygon: Polygon): number[] {
  const cuts = [0, 1];
  const segmentBounds = boundsOf(a, b);
  if (!overlaps(segmentBounds, polygon.bounds)) return cuts;
  const segment = subtract(b, a);
  const lengthSquared = squaredDistance(a, b);
  if (lengthSquared <= EPSILON ** 2) return cuts;
  for (const edge of polygon.edges) {
    if (!overlaps(segmentBounds, edge.bounds)) continue;
    const direction = subtract(edge.b, edge.a), offset = subtract(edge.a, a);
    const denominator = cross(segment, direction);
    if (Math.abs(denominator) > EPSILON) {
      const t = cross(offset, direction) / denominator;
      const u = cross(offset, segment) / denominator;
      if (u >= -EPSILON && u <= 1 + EPSILON) cuts.push(t);
    } else if (Math.abs(cross(offset, segment)) <= EPSILON * Math.sqrt(lengthSquared)) {
      // A stroke following the boundary can enter/leave at an edge endpoint.
      cuts.push((offset.x * segment.x + offset.y * segment.y) / lengthSquared);
      const end = subtract(edge.b, a);
      cuts.push((end.x * segment.x + end.y * segment.y) / lengthSquared);
    }
  }
  return uniqueCuts(cuts);
}

function appendPoint(points: Point[], point: Point): void {
  const previous = points.at(-1);
  if (!previous || squaredDistance(previous, point) > EPSILON ** 2 || Math.abs(previous.pressure - point.pressure) > EPSILON) points.push(point);
}
function splitStroke(stroke: StrokeItem, cutsFor: (a: Point, b: Point) => number[], inside: (point: Point) => boolean): StrokeRun[] {
  if (stroke.points.length === 1) return [{ inside: inside(stroke.points[0]), points: [{ ...stroke.points[0] }] }];
  const runs: StrokeRun[] = [];
  for (let index = 1; index < stroke.points.length; index++) {
    const a = stroke.points[index - 1], b = stroke.points[index];
    const cuts = cutsFor(a, b);
    for (let interval = 1; interval < cuts.length; interval++) {
      const start = cuts[interval - 1], end = cuts[interval];
      if (end - start <= EPSILON) continue;
      const included = inside(mix(a, b, (start + end) / 2));
      let run = runs.at(-1);
      if (!run || run.inside !== included) { run = { inside: included, points: [] }; runs.push(run); }
      appendPoint(run.points, mix(a, b, start));
      appendPoint(run.points, mix(a, b, end));
    }
  }
  return runs;
}
function fragment(stroke: StrokeItem, points: Point[]): StrokeItem {
  return { ...stroke, id: createId(), points };
}

/**
 * Ink is split at the lasso's intersections with its raw centerline, retaining
 * interpolated pressure and all pen settings. Other annotations remain whole and
 * are selected when the center of their visible bounds lies inside the polygon.
 */
export function selectWithinLasso(items: readonly InkItem[], polygon: readonly LassoPoint[]): LassoSelection {
  const prepared = preparePolygon(polygon);
  if (!prepared) return { items: sameItems(items), selectedIds: [] };
  const result: InkItem[] = [], selectedIds: string[] = [];
  let changed = false;
  for (const item of items) {
    if (item.type !== 'stroke') {
      const bounds = itemBounds(item);
      if (contains({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, prepared)) selectedIds.push(item.id);
      result.push(item);
      continue;
    }
    if (!item.points.length || !overlaps(rawStrokeBounds(item), prepared.bounds)) { result.push(item); continue; }
    const runs = splitStroke(item, (a, b) => polygonCuts(a, b, prepared), point => contains(point, prepared));
    const inside = runs.some(run => run.inside), outside = runs.some(run => !run.inside);
    if (!inside || !outside) {
      result.push(item);
      if (inside) selectedIds.push(item.id);
      continue;
    }
    changed = true;
    for (const run of runs) {
      const piece = fragment(item, run.points);
      result.push(piece);
      if (run.inside) selectedIds.push(piece.id);
    }
  }
  return { items: changed ? result : sameItems(items), selectedIds };
}

export function getSelectionBounds(items: readonly InkItem[], ids: readonly string[] | ReadonlySet<string>): ItemBounds | null {
  const selected = new Set(ids);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) if (selected.has(item.id)) {
    const bounds = itemBounds(item);
    minX = Math.min(minX, bounds.x); minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.w); maxY = Math.max(maxY, bounds.y + bounds.h);
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function distanceToSegment(point: LassoPoint, a: LassoPoint, b: LassoPoint): number {
  const segment = subtract(b, a), offset = subtract(point, a);
  const lengthSquared = segment.x * segment.x + segment.y * segment.y;
  const t = lengthSquared > EPSILON ** 2 ? Math.max(0, Math.min(1, (offset.x * segment.x + offset.y * segment.y) / lengthSquared)) : 0;
  return Math.hypot(offset.x - segment.x * t, offset.y - segment.y * t);
}
function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  const roundingTolerance = Number.EPSILON * 32 * (b * b + Math.abs(4 * a * c) + 1);
  if (discriminant < -roundingTolerance) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const q = -0.5 * (b + (b >= 0 ? root : -root));
  return Math.abs(q) < 1e-12 ? [-b / (2 * a)] : [q / a, c / q];
}

/** Exact crossings of a varying-width ink segment with a swept circular eraser. */
function capsuleCuts(stroke: StrokeItem, a: Point, b: Point, from: Point, to: Point, radius: number): number[] {
  const cuts = [0, 1];
  const velocity = subtract(b, a), sweep = subtract(to, from);
  const sweepLength = Math.hypot(sweep.x, sweep.y);
  const initialRadius = radius + strokeRadius(stroke, a);
  const radiusChange = strokeRadius(stroke, b) - strokeRadius(stroke, a);
  const circleRoots = (center: Point) => {
    const offset = subtract(a, center);
    cuts.push(...quadraticRoots(
      velocity.x ** 2 + velocity.y ** 2 - radiusChange ** 2,
      2 * (offset.x * velocity.x + offset.y * velocity.y - initialRadius * radiusChange),
      offset.x ** 2 + offset.y ** 2 - initialRadius ** 2,
    ));
  };
  circleRoots(from);
  if (sweepLength > EPSILON) {
    circleRoots(to);
    const offset = subtract(a, from);
    const perpendicular = cross(offset, sweep) / sweepLength;
    const perpendicularChange = cross(velocity, sweep) / sweepLength;
    for (const sign of [-1, 1]) {
      const denominator = perpendicularChange - sign * radiusChange;
      if (Math.abs(denominator) > 1e-12) cuts.push((sign * initialRadius - perpendicular) / denominator);
    }
    const projection = (offset.x * sweep.x + offset.y * sweep.y) / (sweepLength * sweepLength);
    const projectionChange = (velocity.x * sweep.x + velocity.y * sweep.y) / (sweepLength * sweepLength);
    if (Math.abs(projectionChange) > 1e-12) cuts.push(-projection / projectionChange, (1 - projection) / projectionChange);
  }
  return uniqueCuts(cuts);
}

function intervalThroughBounds(from: Point, to: Point, bounds: ItemBounds): [number, number] | null {
  let start = 0, end = 1;
  for (const [origin, velocity, min, max] of [
    [from.x, to.x - from.x, bounds.x, bounds.x + bounds.w],
    [from.y, to.y - from.y, bounds.y, bounds.y + bounds.h],
  ]) {
    if (Math.abs(velocity) <= EPSILON) { if (origin < min || origin > max) return null; continue; }
    let a = (min - origin) / velocity, b = (max - origin) / velocity;
    if (a > b) [a, b] = [b, a];
    start = Math.max(start, a); end = Math.min(end, b);
    if (start > end) return null;
  }
  return [Math.max(0, start), Math.min(1, end)];
}

function otherItemHit(item: InkItem, from: Point, to: Point, radius: number): boolean {
  const bounds = itemBounds(item);
  const interval = intervalThroughBounds(from, to, { x: bounds.x - radius, y: bounds.y - radius, w: bounds.w + 2 * radius, h: bounds.h + 2 * radius });
  if (!interval) return false;
  const length = Math.hypot(to.x - from.x, to.y - from.y) * (interval[1] - interval[0]);
  const step = Math.max(0.75, Math.min(4, radius * 0.4));
  const count = Math.max(1, Math.ceil(length / step));
  for (let i = 0; i <= count; i++) {
    const t = interval[0] + (interval[1] - interval[0]) * i / count;
    if (hitTest(item, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius)) return true;
  }
  return false;
}

/**
 * Cut pen/highlighter centerlines only where their nib touches the circular
 * eraser swept from `from` to `to`. Other annotation types erase as whole items;
 * paper and original PDF content are never part of the item list.
 */
export function eraseInkPath(items: readonly InkItem[], from: Point, to: Point, radius: number): InkItem[] {
  if (!finitePoint(from) || !finitePoint(to) || !Number.isFinite(radius) || radius < 0) return sameItems(items);
  const sweepBounds = boundsOf(from, to, radius);
  const result: InkItem[] = [];
  let changed = false;
  for (const item of items) {
    if (item.type !== 'stroke') {
      if (otherItemHit(item, from, to, radius)) changed = true; else result.push(item);
      continue;
    }
    if (!item.points.length) { result.push(item); continue; }
    const nibRadius = item.points.reduce((max, point) => Math.max(max, strokeRadius(item, point)), 0);
    if (!overlaps(rawStrokeBounds(item, nibRadius), sweepBounds)) { result.push(item); continue; }
    const erased = (point: Point) => distanceToSegment(point, from, to) <= radius + strokeRadius(item, point);
    const stationary = item.points.every(point => squaredDistance(point, item.points[0]) <= EPSILON ** 2);
    if (stationary) {
      if (item.points.some(erased)) changed = true; else result.push(item);
      continue;
    }
    const runs = splitStroke(item, (a, b) => capsuleCuts(item, a, b, from, to, radius), erased);
    if (!runs.some(run => run.inside)) { result.push(item); continue; }
    changed = true;
    for (const run of runs) if (!run.inside && run.points.length >= 2) result.push(fragment(item, run.points));
  }
  return changed ? result : sameItems(items);
}
