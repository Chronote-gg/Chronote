import { Box, Stack, Text } from "@mantine/core";

/**
 * Discord renders embeds with its own palette regardless of the page theme, so
 * these colours are deliberately hardcoded: the point is that this looks like
 * the artifact Chronote posts, not like the rest of the site.
 */
const DISCORD = {
  messageBackground: "#313338",
  embedBackground: "#2B2D31",
  accent: "#3BA55C",
  heading: "#F2F3F5",
  body: "#DBDEE1",
  muted: "#949BA4",
  mentionText: "#C9CDFB",
  mentionBackground: "rgba(88, 101, 242, 0.3)",
  appBadge: "#5865F2",
} as const;

const SECTIONS = [
  {
    heading: "Summary",
    items: [
      "Game night moves to Saturdays at 8pm ET after three weeks of low Friday turnout.",
      "Spring tournament prize pool is capped at $150, funded from the existing events budget.",
    ],
  },
  {
    heading: "Open Questions",
    items: [
      "Whether the sponsor still wants a banner slot, or would rather put the money into the prize pool.",
      "Whether Saturdays clash with the partner server's raid night.",
    ],
  },
];

const NEXT_STEPS = [
  {
    mention: "@alex",
    rest: " posts the new schedule in announcements before Friday.",
  },
  {
    mention: "@sam",
    rest: " confirms the sponsor's preference ahead of the next sync.",
  },
];

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="li"
      style={{ color: DISCORD.body, fontSize: 14, lineHeight: 1.45 }}
    >
      {children}
    </Box>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <Text fw={700} fz={17} style={{ color: DISCORD.heading }}>
      {children}
    </Text>
  );
}

export function SampleSummary() {
  return (
    <Stack
      gap={6}
      data-testid="sample-summary"
      // The message ground travels with the artifact so the author row keeps
      // its Discord colours in light mode too.
      style={{
        background: DISCORD.messageBackground,
        borderRadius: 8,
        padding: 16,
      }}
    >
      <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Box
          style={{
            background: DISCORD.appBadge,
            color: "#FFFFFF",
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 5px",
            borderRadius: 3,
            letterSpacing: "0.02em",
          }}
        >
          APP
        </Box>
        <Text fw={600} fz={15} style={{ color: DISCORD.heading }}>
          Chronote
        </Text>
      </Box>

      <Box
        style={{
          background: DISCORD.embedBackground,
          borderLeft: `4px solid ${DISCORD.accent}`,
          borderRadius: 4,
          padding: "16px 16px 14px",
          maxWidth: 520,
        }}
      >
        <Stack gap="md">
          <Text fw={700} fz={19} style={{ color: DISCORD.heading }}>
            Meeting Notes
          </Text>

          {SECTIONS.map((section) => (
            <Stack key={section.heading} gap={6}>
              <SectionHeading>{section.heading}</SectionHeading>
              <Box
                component="ul"
                style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}
              >
                {section.items.map((item) => (
                  <Bullet key={item}>{item}</Bullet>
                ))}
              </Box>
            </Stack>
          ))}

          <Stack gap={6}>
            <SectionHeading>Next Steps</SectionHeading>
            <Box
              component="ul"
              style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}
            >
              {NEXT_STEPS.map((step) => (
                <Bullet key={step.mention}>
                  <Box
                    component="span"
                    style={{
                      color: DISCORD.mentionText,
                      background: DISCORD.mentionBackground,
                      borderRadius: 3,
                      padding: "0 2px",
                    }}
                  >
                    {step.mention}
                  </Box>
                  {step.rest}
                </Bullet>
              ))}
            </Box>
          </Stack>

          <Text fz={12} style={{ color: DISCORD.muted }}>
            Community sync, 38 minutes, 5 people
          </Text>
        </Stack>
      </Box>
    </Stack>
  );
}

export default SampleSummary;
