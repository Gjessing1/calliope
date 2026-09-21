import { describe, expect, it } from 'vitest';
import { scanLabel } from './scan-label.js';

describe('scanLabel', () => {
  it('describes discovery before the total is known', () => {
    expect(scanLabel({ phase: 'discovering', found: 0 })).toBe('Finding books…');
    expect(scanLabel({ phase: 'discovering', found: 12 })).toBe('Finding books · 12 found…');
  });

  it('shows the current and total once discovery is complete', () => {
    expect(scanLabel({ phase: 'scanning', current: 7, total: 42 })).toBe('Scanning 7 of 42…');
  });
});
