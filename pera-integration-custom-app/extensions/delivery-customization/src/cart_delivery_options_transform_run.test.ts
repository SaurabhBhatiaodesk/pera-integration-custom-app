import { describe, it, expect } from 'vitest';
import { cartDeliveryOptionsTransformRun } from './cart_delivery_options_transform_run';
import { CartDeliveryOptionsTransformRunResult } from '../generated/api';

describe('delivery customization function', () => {
  it('returns no operations without configuration', () => {
    const result = cartDeliveryOptionsTransformRun({
      deliveryCustomization: {
        metafield: null
      }
    });
    console.log("bbbbbbbbbbbbbbbbbbbbbbb",result);
    const expected: CartDeliveryOptionsTransformRunResult = { operations: [] };

    expect(result).toEqual(expected);
  });
});
