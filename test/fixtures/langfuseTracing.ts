export const propagateAttributes = (_attributes: unknown, run: () => unknown) =>
  run();
export const startActiveObservation = (
  _name: string,
  run: (span: unknown) => unknown,
) => run({ otelSpan: { spanContext: () => ({}) } });
export const updateActiveObservation = jest.fn();
