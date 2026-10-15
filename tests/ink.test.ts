import { describe, expect, it, vi } from 'vitest';
import { getStrokeBounds, getStrokePath, getStrokeSamples, strokeRadius, type InkPathCommand } from '../src/ink';
import { drawItem, hitTest, itemBounds, itemsToSvg } from '../src/drawing';
import type { Point, StrokeItem } from '../src/model';

function stroke(points: Point[], smoothing = 0.55): StrokeItem {
  return { id: 'sample', type: 'stroke', tool: 'pen', width: 4, color: '#315c48', points, smoothing };
}
function finitePath(commands: readonly InkPathCommand[]): boolean {
  return commands.every(command => Object.entries(command).every(([name, value]) => name === 'type' || Number.isFinite(value)));
}
const point = (x: number, y: number, pressure = 0.5): Point => ({ x, y, pressure });

function pathContains(commands: readonly InkPathCommand[], x: number, y: number): boolean {
  let contour: { x: number; y: number }[] = [];
  let current = { x: 0, y: 0 };
  let winding = 0;
  const finish = () => {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length];
      const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y && b.y > y && side > 0) winding++;
      if (a.y > y && b.y <= y && side < 0) winding--;
    }
    contour = [];
  };
  for (const command of commands) {
    if (command.type === 'close') { finish(); continue; }
    if (command.type === 'move') { finish(); contour.push({ x: command.x, y: command.y }); }
    else if (command.type === 'line') contour.push({ x: command.x, y: command.y });
    else if (command.type === 'cubic') {
      const start = current;
      for (let i = 1; i <= 16; i++) {
        const t = i / 16, u = 1 - t;
        contour.push({
          x: u ** 3 * start.x + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t ** 3 * command.x,
          y: u ** 3 * start.y + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t ** 3 * command.y,
        });
      }
    }
    current = { x: command.x, y: command.y };
  }
  finish();
  return winding !== 0;
}

describe('smooth pen geometry', () => {
  it('reduces small hand jitter while retaining both exact endpoint positions', () => {
    const raw = Array.from({ length: 61 }, (_, i) => point(i * 2, i % 2 ? 1.6 : -1.6));
    const ink = stroke(raw, 0.85);
    const samples = getStrokeSamples(ink);
    const interior = samples.filter(sample => sample.x > 20 && sample.x < 100);
    const rms = Math.sqrt(interior.reduce((sum, sample) => sum + sample.y ** 2, 0) / interior.length);
    expect(rms).toBeLessThan(0.8);
    expect(samples[0]).toMatchObject({ x: raw[0].x, y: raw[0].y });
    expect(samples.at(-1)).toMatchObject({ x: raw.at(-1)!.x, y: raw.at(-1)!.y });
    const defaultSamples = getStrokeSamples(stroke(raw)).filter(sample => sample.x > 20 && sample.x < 100);
    const defaultRms = Math.sqrt(defaultSamples.reduce((sum, sample) => sum + sample.y ** 2, 0) / defaultSamples.length);
    expect(defaultRms).toBeLessThan(0.65);
  });

  it('preserves deliberate corners and uses curve geometry instead of sparse joins', () => {
    const ink = stroke([point(0, 0), point(20, 0), point(20, 20), point(40, 20)]);
    const samples = getStrokeSamples(ink);
    expect(samples).toContainEqual(expect.objectContaining({ x: 20, y: 0 }));
    expect(samples).toContainEqual(expect.objectContaining({ x: 20, y: 20 }));
    expect(getStrokePath(ink).some(command => command.type === 'cubic')).toBe(true);
    expect(hitTest(ink, 20, 0, 0)).toBe(true);
    expect(hitTest(ink, 5, 15, 0)).toBe(false);
  });

  it('reduces coarse capture jitter without treating every noisy sample as a corner', () => {
    const raw = Array.from({ length: 61 }, (_, i) => point(90 + i * 8, 230 + Math.sin(i * 0.17) * 32 + (i % 2 ? -5 : 5)));
    const samples = getStrokeSamples(stroke(raw)).filter(sample => sample.x > 114 && sample.x < 546);
    const errors = samples.map(sample => sample.y - 230 - Math.sin((sample.x - 90) / 8 * 0.17) * 32);
    const rms = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
    expect(rms).toBeLessThan(2.5); // Raw captured noise has 5 px RMS.
    const corner = stroke([point(0, 0), point(8, 0), point(16, 0), point(24, 0), point(24, 8), point(24, 16), point(24, 24)]);
    expect(getStrokeSamples(corner)).toContainEqual(expect.objectContaining({ x: 24, y: 0 }));
  });

  it('stabilizes inconsistent pressure without flattening it to a constant width', () => {
    const ink = stroke(Array.from({ length: 31 }, (_, i) => point(i * 3, 0, i % 2 ? 0.9 : 0.1)), 0.9);
    const middle = getStrokeSamples(ink).filter(sample => sample.x > 25 && sample.x < 65);
    const pressures = middle.map(sample => sample.pressure);
    expect(Math.max(...pressures) - Math.min(...pressures)).toBeLessThan(0.3);
    const gradual = stroke(Array.from({ length: 31 }, (_, i) => point(i * 3, 0, i / 30)), 0.9);
    const samples = getStrokeSamples(gradual);
    expect(samples.at(-1)!.pressure - samples[0].pressure).toBeGreaterThan(0.75);
  });

  it('keeps the off setting faithful to raw input, including duplicate positions', () => {
    const raw = [point(0, 0, 0.1), point(0, 0, 0.7), point(2, 4, 0.3), point(8, -2, 0.9)];
    expect(getStrokeSamples(stroke(raw, 0))).toEqual(raw);
    expect(finitePath(getStrokePath(stroke(raw, 0)))).toBe(true);
  });

  it('retains legacy default smoothing, dots, and exact two-point lines', () => {
    const dot = stroke([point(50, 50, 1)]);
    expect(strokeRadius(dot, dot.points[0])).toBe(3.5);
    expect(getStrokeBounds(dot)).toEqual({ x: 46.5, y: 46.5, w: 7, h: 7 });
    const line = stroke([point(0, 0), point(100, 0)]);
    expect(getStrokeSamples(line)).toEqual(line.points);
    const old = { ...stroke([point(0, 0), point(4, 2), point(8, -2), point(12, 0)]) };
    delete old.smoothing;
    expect(getStrokePath(old)).toEqual(getStrokePath({ ...old, smoothing: 0.55 }));
  });

  it('handles stationary pressure, cusps, and dense duplicates without NaN or spikes', () => {
    const inks = [
      stroke(Array.from({ length: 40 }, (_, i) => point(10, 10, i % 2 ? 0.8 : 0.2))),
      stroke([point(0, 0), point(30, 0), point(0, 0), point(0, 20)]),
      stroke([point(10, 10), point(10.000001, 10), point(10.000002, 10)]),
      stroke([point(0, 0, 0.1), point(0.5, 0, 1)], 0),
    ];
    for (const ink of inks) {
      expect(finitePath(getStrokePath(ink))).toBe(true);
      const bounds = getStrokeBounds(ink);
      expect(bounds.w).toBeLessThan(50);
      expect(bounds.h).toBeLessThan(40);
    }
  });

  it('fills tight wide-marker loops without offset-ribbon holes', () => {
    const points = Array.from({ length: 49 }, (_, i) => point(20 + 4 * Math.cos(i * Math.PI / 24), 20 + 4 * Math.sin(i * Math.PI / 24)));
    const marker: StrokeItem = { ...stroke(points), tool: 'highlighter', width: 20 };
    const path = getStrokePath(marker);
    expect(pathContains(path, 20, 20)).toBe(true);
    expect(pathContains(path, 10, 20)).toBe(true);
    expect(pathContains(path, 4, 20)).toBe(false);
    expect(hitTest(marker, 20, 20, 0)).toBe(true);
  });

  it('keeps geometry out of notebook serialization and leaves raw samples untouched', () => {
    const ink = stroke([point(0, 0, 0.1), point(4, 1, 0.8), point(8, -1, 0.2), point(12, 0, 0.7)]);
    const before = JSON.stringify(ink);
    getStrokeSamples(ink); getStrokePath(ink); itemBounds(ink); itemsToSvg([ink]);
    expect(JSON.stringify(ink)).toBe(before);
  });

  it('reuses completed geometry and invalidates live appends and final-point updates', () => {
    const ink = stroke([point(0, 0), point(4, 2), point(8, 0)]);
    const firstPath = getStrokePath(ink);
    expect(getStrokePath(ink)).toBe(firstPath);
    ink.points.push(point(12, 3));
    const appended = getStrokePath(ink);
    expect(appended).not.toBe(firstPath);
    ink.points.at(-1)!.x = 15;
    const moved = getStrokePath(ink);
    expect(moved).not.toBe(appended);
    ink.points.at(-1)!.pressure = 0.9;
    expect(getStrokePath(ink)).not.toBe(moved);
    const beforeSettings = getStrokePath(ink);
    ink.smoothing = 0;
    expect(getStrokePath(ink)).not.toBe(beforeSettings);
  });

  it('bounds smoothing work for long handwriting that stays in one small area', () => {
    const ink = stroke(Array.from({ length: 1000 }, (_, i) => point(100 + Math.sin(i * 0.07) * 2, 100 + Math.cos(i * 0.07) * 2)));
    const hypot = vi.spyOn(Math, 'hypot');
    let calls = 0;
    try {
      expect(finitePath(getStrokePath(ink))).toBe(true);
      calls = hypot.mock.calls.length;
    } finally { hypot.mockRestore(); }
    // An unbounded spatial search used over a million distance evaluations for
    // this fixture; a fixed local context keeps work proportional to samples.
    expect(calls).toBeLessThan(200_000);
  });

  it('reuses native graphics paths across completed-stroke repaints and refreshes live edits', () => {
    const native: { commands: InkPathCommand[] }[] = [];
    class NativePath {
      commands: InkPathCommand[] = [];
      constructor() { native.push(this); }
      moveTo(x: number, y: number) { this.commands.push({ type: 'move', x, y }); }
      lineTo(x: number, y: number) { this.commands.push({ type: 'line', x, y }); }
      bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) { this.commands.push({ type: 'cubic', x1, y1, x2, y2, x, y }); }
      closePath() { this.commands.push({ type: 'close' }); }
    }
    const fills: unknown[] = [];
    const context = {
      globalAlpha: 1, fillStyle: '', save() {}, restore() {},
      fill(path: unknown, rule: CanvasFillRule) { expect(rule).toBe('nonzero'); fills.push(path); },
    };
    const ink = stroke([point(0, 0), point(4, 2), point(8, 0)]);
    vi.stubGlobal('Path2D', NativePath);
    try {
      drawItem(context as unknown as CanvasRenderingContext2D, ink);
      drawItem(context as unknown as CanvasRenderingContext2D, ink);
      expect(native).toHaveLength(1);
      expect(native[0].commands).toEqual(getStrokePath(ink));
      expect(fills).toEqual([native[0], native[0]]);
      ink.points.push(point(12, 3));
      drawItem(context as unknown as CanvasRenderingContext2D, ink);
      expect(native).toHaveLength(2);
      expect(native[1].commands).toEqual(getStrokePath(ink));
      expect(fills[2]).toBe(native[1]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('replays exactly the shared path and composites a highlighter only once', () => {
    const ink: StrokeItem = { ...stroke([point(0, 0), point(10, 4), point(20, -3), point(30, 0)]), tool: 'highlighter', width: 15 };
    const commands: InkPathCommand[] = [];
    const fills: { alpha: number; rule: CanvasFillRule | undefined }[] = [];
    const context = {
      globalAlpha: 1, fillStyle: '', save() {}, restore() {}, beginPath() {},
      moveTo(x: number, y: number) { commands.push({ type: 'move', x, y }); },
      lineTo(x: number, y: number) { commands.push({ type: 'line', x, y }); },
      bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) { commands.push({ type: 'cubic', x1, y1, x2, y2, x, y }); },
      closePath() { commands.push({ type: 'close' }); },
      fill(rule?: CanvasFillRule) { fills.push({ alpha: this.globalAlpha, rule }); },
    };
    drawItem(context as unknown as CanvasRenderingContext2D, ink);
    expect(commands).toEqual(getStrokePath(ink));
    expect(fills).toEqual([{ alpha: 0.3, rule: 'nonzero' }]);
    const svg = itemsToSvg([ink]);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('C');
    expect(svg).toContain('opacity="0.3"');
  });
});
