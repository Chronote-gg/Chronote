const LANGFUSE_ATTRIBUTE_VALUE_MAX_LENGTH = 200;

export function toLangfuseAttributeMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [
        key,
        String(value).slice(0, LANGFUSE_ATTRIBUTE_VALUE_MAX_LENGTH),
      ]),
  );
}
