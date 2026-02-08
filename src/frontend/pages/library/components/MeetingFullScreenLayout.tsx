import type { ReactNode } from "react";
import { Box, useMantineTheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

type MeetingFullScreenLayoutProps = {
  left: ReactNode;
  right: ReactNode;
};

export function MeetingFullScreenLayout({
  left,
  right,
}: MeetingFullScreenLayoutProps) {
  const theme = useMantineTheme();
  const lgBreakpoint = theme.breakpoints.lg;
  // Mantine breakpoints are CSS length strings (typically `em`). If a theme ever
  // provides a unitless numeric string, treat it as px to keep the media query
  // valid.
  const lgMinWidth = /\d$/.test(lgBreakpoint)
    ? `${lgBreakpoint}px`
    : lgBreakpoint;
  const isLgUp = useMediaQuery(`(min-width: ${lgMinWidth})`);

  return (
    <Box
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gap: theme.spacing.lg,
        gridTemplateColumns: isLgUp ? "5fr 7fr" : "1fr",
        gridTemplateRows: isLgUp
          ? "minmax(0, 1fr)"
          : "minmax(0, 0.9fr) minmax(0, 1.1fr)",
      }}
    >
      <Box
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {left}
      </Box>
      <Box
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {right}
      </Box>
    </Box>
  );
}

export default MeetingFullScreenLayout;
