import {
  Anchor,
  Box,
  Container,
  Divider,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { buildInstallUrl } from "../utils/discordInvite";

const DOCS_URL = "https://docs.chronote.gg";

type FooterLink = {
  label: string;
  href: string;
  external?: boolean;
};

const FOOTER_LINKS: FooterLink[] = [
  {
    label: "GitHub",
    href: "https://github.com/Chronote-gg/chronote",
    external: true,
  },
  { label: "Docs", href: DOCS_URL, external: true },
  { label: "Privacy", href: `${DOCS_URL}/legal/privacy/`, external: true },
  { label: "Terms", href: `${DOCS_URL}/legal/terms/`, external: true },
];

type SiteFooterProps = {
  variant?: "default" | "compact";
};

function FooterLinks() {
  const footerLinks: FooterLink[] = [
    {
      label: "Add to Discord",
      href: buildInstallUrl({ ctaLocation: "site-footer" }),
    },
    ...FOOTER_LINKS,
  ];
  return (
    <>
      {footerLinks.map((link) => (
        <Anchor
          key={link.label}
          href={link.href}
          size="sm"
          target={link.external ? "_blank" : undefined}
          rel={link.external ? "noreferrer" : undefined}
        >
          {link.label}
        </Anchor>
      ))}
    </>
  );
}

function FooterAttribution() {
  return (
    <Text size="sm" c="dimmed">
      Chronote by{" "}
      <Anchor
        href="https://basicbit.net/"
        c="inherit"
        target="_blank"
        rel="noreferrer"
      >
        BASICBIT
      </Anchor>
    </Text>
  );
}

export function SiteFooter({ variant = "default" }: SiteFooterProps) {
  const isCompact = variant === "compact";
  const content = (
    <Container size={isCompact ? undefined : "xl"} fluid={isCompact} py="md">
      {isCompact ? (
        <Group justify="center" gap="lg" wrap="wrap">
          <FooterAttribution />
          <FooterLinks />
        </Group>
      ) : (
        <Group justify="space-between" gap="md" wrap="wrap">
          <FooterAttribution />
          <Group gap="lg" wrap="wrap">
            <FooterLinks />
          </Group>
        </Group>
      )}
    </Container>
  );

  if (variant === "compact") {
    return <Box>{content}</Box>;
  }

  return (
    <Stack gap="md" mt="xl">
      <Divider />
      {content}
    </Stack>
  );
}

export default SiteFooter;
