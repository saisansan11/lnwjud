import { describe, expect, it } from 'vitest';
import { BoundedContinuationStore } from './bounded-continuation-store.js';

describe('BoundedContinuationStore', () => {
  it('consumes entries once and expires abandoned continuations by TTL', () => {
    let now = 1_000;
    const store = new BoundedContinuationStore<string>({ maxEntries: 4, ttlMs: 100, now: (): number => now });

    store.set('token', 'value');
    expect(store.take('token')).toBe('value');
    expect(store.take('token')).toBeUndefined();

    store.set('expired', 'old');
    now += 101;
    expect(store.take('expired')).toBeUndefined();
  });

  it('evicts the oldest abandoned continuation when capacity is reached', () => {
    let now = 1_000;
    const store = new BoundedContinuationStore<string>({ maxEntries: 2, ttlMs: 10_000, now: (): number => now });

    store.set('first', 'one');
    now += 1;
    store.set('second', 'two');
    now += 1;
    store.set('third', 'three');

    expect(store.take('first')).toBeUndefined();
    expect(store.take('second')).toBe('two');
    expect(store.take('third')).toBe('three');
  });
});
