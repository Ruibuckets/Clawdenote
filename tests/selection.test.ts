import { describe, expect, it } from 'vitest';
import { eraseInkPath, getSelectionBounds, pointInLasso, selectWithinLasso } from '../src/selection';
import { itemBounds } from '../src/drawing';
import { strokeRadius } from '../src/ink';
import type { ImageItem, InkItem, Point, ShapeItem, StrokeItem, TextItem } from '../src/model';

const point = (x: number, y: number, pressure = 0.5): Point => ({ x, y, pressure });
const box = [{ x: -3, y: -3 }, { x: 3, y: -3 }, { x: 3, y: 3 }, { x: -3, y: 3 }];
function stroke(points: Point[], options: Partial<StrokeItem> = {}): StrokeItem {
  return { id: 'ink', type: 'stroke', tool: 'pen', color: '#315c48', width: 2, smoothing: 0.7, points, ...options };
}
function strokes(items: InkItem[]): StrokeItem[] {
  return items.filter((item): item is StrokeItem => item.type === 'stroke');
}

describe('lasso selection', () => {
  it('includes polygon edges and vertices, supports concavity, and rejects degenerate lassos', () => {
    expect(pointInLasso({ x: 0, y: 0 }, box)).toBe(true);
    expect(pointInLasso({ x: 3, y: 2 }, box)).toBe(true);
    expect(pointInLasso({ x: -3, y: -3 }, box)).toBe(true);
    expect(pointInLasso({ x: 4, y: 0 }, box)).toBe(false);
    const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 }, { x: 0, y: 10 }];
    expect(pointInLasso({ x: 2, y: 7 }, concave)).toBe(true);
    expect(pointInLasso({ x: 5, y: 9 }, concave)).toBe(false);
    expect(pointInLasso({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(false);
  });

  it('splits a crossing stroke at exact boundaries and interpolates its pressure', () => {
    const original = stroke([point(-10, 0, 0.1), point(10, 0, 0.9)]);
    const before = JSON.stringify(original);
    const selected = selectWithinLasso([original], box);
    const pieces = strokes(selected.items);
    expect(pieces).toHaveLength(3);
    expect(pieces.map(piece => piece.points.map(point => point.x))).toEqual([[-10, -3], [-3, 3], [3, 10]]);
    expect(pieces[1].points[0].pressure).toBeCloseTo(0.38);
    expect(pieces[1].points[1].pressure).toBeCloseTo(0.62);
    expect(selected.selectedIds).toEqual([pieces[1].id]);
    expect(new Set(pieces.map(piece => piece.id)).size).toBe(3);
    expect(pieces.every(piece => piece.id !== original.id && piece.smoothing === 0.7 && piece.color === original.color)).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps complete strokes and no-op item lists by identity', () => {
    const inside = stroke([point(-1, 0), point(1, 0)], { id: 'inside' });
    const outside = stroke([point(8, 0), point(12, 0)], { id: 'outside' });
    const items = [inside, outside];
    const selected = selectWithinLasso(items, box);
    expect(selected.items).toBe(items);
    expect(selected.selectedIds).toEqual(['inside']);
    expect(selectWithinLasso(items, []).items).toBe(items);
  });

  it('selects complete text, shapes, and images by bounds center without altering them', () => {
    const image: ImageItem = { id: 'image', type: 'image', x: -8, y: -2, w: 16, h: 4, dataUrl: 'data:image/png;base64,AA==' };
    const shape: ShapeItem = { id: 'shape', type: 'shape', shape: 'rectangle', x: -2, y: -2, w: 4, h: 4, width: 1, color: '#000' };
    const text: TextItem = { id: 'text', type: 'text', x: 20, y: 20, text: 'Outside', fontSize: 10, color: '#000' };
    const items = [image, shape, text];
    const selected = selectWithinLasso(items, box);
    expect(selected.items).toBe(items);
    expect(selected.selectedIds).toEqual(['image', 'shape']);
  });

  it('handles concave re-entry, boundary-following strokes, and dots', () => {
    const polygon = [{ x: -8, y: -2 }, { x: 8, y: -2 }, { x: 8, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 0 }, { x: -3, y: 0 }, { x: -3, y: 2 }, { x: -8, y: 2 }];
    const crossing = selectWithinLasso([stroke([point(-12, 1), point(12, 1)])], polygon);
    expect(crossing.items).toHaveLength(5);
    expect(crossing.selectedIds).toHaveLength(2);
    const boundary = stroke([point(-10, -3), point(10, -3)]);
    expect(selectWithinLasso([boundary], box).selectedIds).toHaveLength(1);
    const dot = stroke([point(3, 0)]);
    expect(selectWithinLasso([dot], box).selectedIds).toEqual([dot.id]);
  });
});

describe('circular ink erasing', () => {
  it('cuts only the middle of a stroke and retains both outside fragments', () => {
    const original = stroke([point(-20, 0), point(20, 0)]);
    const before = JSON.stringify(original);
    const result = strokes(eraseInkPath([original], point(0, 0), point(0, 0), 4));
    expect(result).toHaveLength(2);
    expect(result[0].points[0].x).toBe(-20);
    expect(result[0].points.at(-1)!.x).toBeCloseTo(-5);
    expect(result[1].points[0].x).toBeCloseTo(5);
    expect(result[1].points.at(-1)!.x).toBe(20);
    expect(result.every(piece => piece.id !== original.id && piece.smoothing === original.smoothing)).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('interpolates pressure at variable-width cuts and includes the nib in the radius', () => {
    const original = stroke([point(-20, 0, 0.2), point(20, 0, 0.8)], { width: 4 });
    const pieces = strokes(eraseInkPath([original], point(0, 0), point(0, 0), 4));
    for (const cut of [pieces[0].points.at(-1)!, pieces[1].points[0]]) {
      expect(cut.pressure).toBeCloseTo(0.2 + (cut.x + 20) / 40 * 0.6);
      expect(Math.abs(cut.x)).toBeCloseTo(4 + strokeRadius(original, cut));
    }
    const grazing = stroke([point(-20, 5), point(20, 5)], { width: 4 });
    expect(eraseInkPath([grazing], point(0, 0), point(0, 0), 4)).toHaveLength(2);
  });

  it('covers fast swept eraser paths even when both pointer samples are far away', () => {
    const original = stroke([point(-50, 0), point(50, 0)]);
    const pieces = strokes(eraseInkPath([original], point(0, -100), point(0, 100), 3));
    expect(pieces).toHaveLength(2);
    expect(pieces[0].points.at(-1)!.x).toBeCloseTo(-4);
    expect(pieces[1].points[0].x).toBeCloseTo(4);
  });

  it('uses the highlighter nib width and retains all stroke settings', () => {
    const marker = stroke([point(-30, 12, 0.1), point(30, 12, 0.9)], { tool: 'highlighter', width: 20, color: '#f2cc57' });
    const pieces = strokes(eraseInkPath([marker], point(0, 0), point(0, 0), 4));
    expect(pieces).toHaveLength(2);
    expect(pieces[0].points.at(-1)!.x).toBeCloseTo(-Math.sqrt(14 ** 2 - 12 ** 2));
    expect(pieces.every(piece => piece.tool === 'highlighter' && piece.width === 20 && piece.color === marker.color)).toBe(true);
  });

  it('preserves no-op identities, removes fully erased strokes, and handles pen dots', () => {
    const original = stroke([point(-20, 0), point(20, 0)]);
    const items = [original];
    expect(eraseInkPath(items, point(0, 20), point(0, 30), 3)).toBe(items);
    expect(eraseInkPath(items, point(-40, 0), point(40, 0), 3)).toEqual([]);
    expect(eraseInkPath([stroke([point(0, 0)])], point(0, 0), point(0, 0), 3)).toEqual([]);
    expect(eraseInkPath(items, point(0, 0), point(0, 0), Number.NaN)).toBe(items);
  });

  it('does not multiply fragments when re-erasing the same area', () => {
    const original = stroke([point(-20, 0), point(0, 0), point(20, 0)]);
    const first = eraseInkPath([original], point(0, -10), point(0, 10), 3);
    const second = eraseInkPath(first, point(0, -10), point(0, 10), 3);
    expect(second).toBe(first);
    expect(second).toHaveLength(2);
  });

  it('does not erase a whole segment when the circular boundary only grazes it', () => {
    const tangent = stroke([point(-20, 5), point(20, 5)]);
    const justOutside = stroke([point(-20, 5.00000005), point(20, 5.00000005)]);
    const items = [tangent, justOutside];
    expect(eraseInkPath(items, point(0, 0), point(0, 0), 4)).toBe(items);
  });

  it('erases other intersected annotations as whole items while preserving distant items', () => {
    const image: ImageItem = { id: 'image', type: 'image', x: -2, y: -2, w: 4, h: 4, dataUrl: 'data:image/png;base64,AA==' };
    const shape: ShapeItem = { id: 'shape', type: 'shape', shape: 'line', x: 30, y: -10, w: 0, h: 20, width: 1, color: '#000' };
    const far = stroke([point(100, 100), point(120, 100)], { id: 'far' });
    const result = eraseInkPath([image, shape, far], point(-50, 0), point(50, 0), 3);
    expect(result).toEqual([far]);
    expect(result[0]).toBe(far);
  });
});

describe('selection bounds', () => {
  it('unites the rendered bounds of selected fragments and returns null for no selection', () => {
    const first = stroke([point(0, 0), point(10, 0)], { id: 'first' });
    const second = stroke([point(30, 10), point(40, 10)], { id: 'second' });
    const a = itemBounds(first), b = itemBounds(second);
    expect(getSelectionBounds([first, second], ['first', 'second'])).toEqual({ x: a.x, y: a.y, w: b.x + b.w - a.x, h: b.y + b.h - a.y });
    expect(getSelectionBounds([first, second], new Set(['first']))).toEqual(a);
    expect(getSelectionBounds([first, second], ['missing'])).toBeNull();
  });
});
