import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
  Operation,
} from "../generated/api";

export function cartDeliveryOptionsTransformRun(
  input: CartDeliveryOptionsTransformRunInput
): CartDeliveryOptionsTransformRunResult {

  // Step 1: Check for the product. Use lowercase to avoid errors.
  const hasClickAndCollectProduct = input.cart.lines.some(line =>
    line.merchandise.product?.title?.toLowerCase().includes('click & collect')
  );

  // Step 2: If the product is found...
  if (hasClickAndCollectProduct) {
    // ...hide everything that is NOT "Click And Collect".
    const operations: Operation[] = input.cart.deliveryGroups.flatMap(group =>
      group.deliveryOptions
        .filter(option => option.title !== 'Click And Collect')
        .map(option => ({
          deliveryOptionHide: {
            deliveryOptionHandle: option.handle,
          },
        }))
    );
    return { operations };
  }

  // Step 3: If the product is NOT found...
  // ...hide the "Click And Collect" option.
  const operations: Operation[] = input.cart.deliveryGroups.flatMap(group =>
    group.deliveryOptions
      .filter(option => option.title === 'Click And Collect')
      .map(option => ({
        deliveryOptionHide: {
          deliveryOptionHandle: option.handle,
        },
      }))
  );
  return { operations };
}
