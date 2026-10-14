import { describe, expect, it } from 'vitest';
import { A4_HEIGHT, A4_WIDTH, clonePage, createDocument, createPage, validateDocument } from '../src/model';

describe('notebook persistence', () => {
  it('creates a valid A4 notebook and validates its JSON round trip', () => {
    const document = createDocument('Lecture notes');
    expect(document.pages[0]).toMatchObject({ width: A4_WIDTH, height: A4_HEIGHT, paper: 'blank' });
    expect(validateDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });

  it('duplicates page and ink IDs without sharing stroke points or PDF references', () => {
    const page = createPage('graph', '#fff7e8');
    page.pdf = { sourceId: 'source', pageIndex: 2 };
    page.items.push({ id: 'stroke', type: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 10, y: 20, pressure: 0.7 }] });
    const copy = clonePage(page);
    expect(copy.id).not.toBe(page.id);
    expect(copy.items[0].id).not.toBe('stroke');
    expect(copy.pdf).toEqual(page.pdf);
    expect(copy.pdf).not.toBe(page.pdf);
    if (copy.items[0].type === 'stroke') copy.items[0].points[0].x = 99;
    expect(page.items[0].type === 'stroke' && page.items[0].points[0].x).toBe(10);
  });

  it('rejects corrupted geometry and missing PDF sources', () => {
    const document = createDocument();
    document.pages[0].width = Number.NaN;
    expect(() => validateDocument(document)).toThrow('width');
    document.pages[0].width = A4_WIDTH;
    document.pages[0].pdf = { sourceId: 'missing', pageIndex: 0 };
    expect(() => validateDocument(document)).toThrow('embedded PDF source');
  });

  it('rejects duplicate IDs and preserves a valid embedded PDF page', () => {
    const document = createDocument();
    document.pdfSources.source = 'JVBERi0=';
    document.pages[0].pdf = { sourceId: 'source', pageIndex: 0 };
    expect(validateDocument(document).pages[0].pdf).toEqual(document.pages[0].pdf);
    document.pages.push({ ...document.pages[0] });
    expect(() => validateDocument(document)).toThrow('unique');
  });
});
