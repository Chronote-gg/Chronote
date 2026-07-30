import { Text, useComputedColorScheme, type TextProps } from "@mantine/core";
import { uiTypography } from "../uiTokens";

type WordmarkProps = Pick<TextProps, "size" | "fz">;

/**
 * Single source of truth for the wordmark so the header and the hero cannot
 * drift apart in colour or face.
 */
export function Wordmark({ size, fz }: WordmarkProps) {
  const isDark = useComputedColorScheme("dark") === "dark";
  return (
    <Text
      size={size}
      fz={fz}
      c={isDark ? "white" : "dark.9"}
      style={uiTypography.logo}
    >
      Chronote
    </Text>
  );
}

export default Wordmark;
