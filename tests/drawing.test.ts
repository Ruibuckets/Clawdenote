import { describe, expect, it } from 'vitest';
import { hitTest, itemBounds, itemsToSvg, strokeRadius, translateItem } from '../src/drawing';
import type { ShapeItem, StrokeItem, TextItem } from '../src/model';

const stroke: StrokeItem = { id: 's', type: 'stroke', tool: 'pen', color: '#000', width: 4, points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 100, y: 100, pressure: 0.5 }] };
const rectangle: ShapeItem = { id: 'r', type: 'shape', shape: 'rectangle', color: '#000', width: 2, x: 0, y: 0, w: 100, h: 100 };

describe('ink hit testing and exports', () => {
  it('erases actual stroke segments without erasing empty space in their bounds', () => {
    expect(hitTest(stroke, 50, 50, 2)).toBe(true);
    expect(hitTest(stroke, 10, 90, 2)).toBe(false);
    expect(hitTest(stroke, 102, 102, 2)).toBe(true);
  });

  it('accounts for pressure on both bounds and single pen dots', () => {
    const dot: StrokeItem = { ...stroke, width: 20, points: [{ x: 50, y: 50, pressure: 1 }] };
    expect(strokeRadius(dot, dot.points[0])).toBe(17.5);
    expect(itemBounds(dot)).toEqual({ x: 32.5, y: 32.5, w: 35, h: 35 });
    expect(hitTest(dot, 66, 50, 0)).toBe(true);
    expect(hitTest(dot, 68, 50, 0)).toBe(false);
  });

  it('tests hollow shape outlines, including reversed rectangles and stretched ellipses', () => {
    expect(hitTest(rectangle, 50, 50, 1)).toBe(false);
    expect(hitTest(rectangle, 0, 50, 1)).toBe(true);
    const reversed: ShapeItem = { ...rectangle, x: 100, y: 100, w: -100, h: -100 };
    expect(hitTest(reversed, 0, 50, 1)).toBe(true);
    const ellipse: ShapeItem = { ...rectangle, shape: 'ellipse', w: 400, h: 40 };
    expect(hitTest(ellipse, 200, 20, 1)).toBe(false);
    expect(hitTest(ellipse, 200, 0, 1)).toBe(true);
    expect(hitTest(ellipse, 0, 20, 1)).toBe(true);
  });

  it('includes arrowheads in selectable bounds', () => {
    const arrow: ShapeItem = { ...rectangle, shape: 'arrow', w: 100, h: 0 };
    expect(itemBounds(arrow).h).toBeGreaterThan(10);
    expect(hitTest(arrow, 94, 3.5, 1)).toBe(true);
    expect(hitTest(arrow, 50, 20, 1)).toBe(false);
  });

  it('moves strokes without mutating their history snapshot', () => {
    const translated = translateItem(stroke, 15, -10);
    expect(translated.type === 'stroke' && translated.points[1]).toEqual({ x: 115, y: 90, pressure: 0.5 });
    expect(stroke.points[1]).toEqual({ x: 100, y: 100, pressure: 0.5 });
  });

  it('exports one compound highlighter path and escapes SVG text', () => {
    const marker: StrokeItem = { ...stroke, tool: 'highlighter' };
    const svg = itemsToSvg([marker]);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('opacity="0.3"');
    const text: TextItem = { id: 't', type: 'text', x: 0, y: 0, text: '<script>&"', color: '#111', fontSize: 14 };
    expect(itemsToSvg([text])).toContain('&lt;script&gt;&amp;&quot;');
  });
});
