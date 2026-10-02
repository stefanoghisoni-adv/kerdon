import { describe, it, expect } from 'vitest';
import { customerRemainingMessage } from './customer-remaining';

describe('customerRemainingMessage', () => {
  it('restituisce unlimited quando il limite è null', () => {
    const result = customerRemainingMessage(50, null);
    expect(result).toEqual({ key: 'unlimited', tone: 'subdued' });
  });

  it('restituisce remaining con tono caution quando remaining è 0', () => {
    const result = customerRemainingMessage(100, 100);
    expect(result).toEqual({ key: 'remaining', remaining: 0, tone: 'caution' });
  });

  it('restituisce remaining con tono caution quando active supera limit', () => {
    const result = customerRemainingMessage(150, 100);
    expect(result).toEqual({ key: 'remaining', remaining: 0, tone: 'caution' });
  });

  it('restituisce remaining con tono subdued quando remaining è 1', () => {
    const result = customerRemainingMessage(99, 100);
    expect(result).toEqual({ key: 'remaining', remaining: 1, tone: 'subdued' });
  });

  it('restituisce remaining con tono subdued quando remaining è N > 1', () => {
    const result = customerRemainingMessage(40, 100);
    expect(result).toEqual({ key: 'remaining', remaining: 60, tone: 'subdued' });
  });

  it('restituisce remaining con tono subdued quando remaining è molto alto', () => {
    const result = customerRemainingMessage(10, 1000);
    expect(result).toEqual({ key: 'remaining', remaining: 990, tone: 'subdued' });
  });

  it('gestisce il caso limite con active a 0', () => {
    const result = customerRemainingMessage(0, 50);
    expect(result).toEqual({ key: 'remaining', remaining: 50, tone: 'subdued' });
  });
});
