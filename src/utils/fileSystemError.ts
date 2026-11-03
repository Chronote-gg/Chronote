export function hasFileSystemCode(error: unknown, ...codes: string[]): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}
