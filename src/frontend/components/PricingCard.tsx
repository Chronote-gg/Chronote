import {
  Badge,
  Box,
  Button,
  type ButtonProps,
  List,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import type { MouseEventHandler } from "react";
import Surface from "./Surface";
import { uiBorders, uiColors } from "../uiTokens";

type ButtonVariant =
  | "filled"
  | "light"
  | "outline"
  | "transparent"
  | "white"
  | "subtle"
  | "default"
  | "gradient";

type PricingCtaProps = Omit<ButtonProps, "children"> & {
  variant?: ButtonVariant;
  onClick?: MouseEventHandler<HTMLButtonElement>;
};

type PricingCardProps = {
  name: string;
  price: string;
  description: string;
  features: string[];
  cta?: string;
  ctaProps?: PricingCtaProps;
  ctaDisabled?: boolean;
  highlighted?: boolean;
  badge?: string;
  note?: string;
  billingLabel?: string;
  tone?: "default" | "raised" | "soft";
  borderColor?: string;
  borderWidth?: number;
  testId?: string;
};

const resolveBadgeLabel = (highlighted: boolean, badge?: string) =>
  highlighted ? (badge ?? "Best value") : badge;

const resolveButtonVariant = (
  highlighted: boolean,
  ctaProps?: PricingCtaProps,
): ButtonVariant => ctaProps?.variant ?? (highlighted ? "gradient" : "outline");

const resolveButtonGradient = (
  highlighted: boolean,
  ctaProps?: PricingCtaProps,
) =>
  ctaProps?.gradient ??
  (highlighted ? { from: "brand", to: "violet" } : undefined);

const resolveButtonDisabled = (
  ctaProps?: PricingCtaProps,
  disabled?: boolean,
) => disabled ?? ctaProps?.disabled ?? false;

const resolveTone = (highlighted: boolean, tone?: PricingCardProps["tone"]) =>
  tone ?? (highlighted ? "raised" : "default");

const resolveBorderWidth = (highlighted: boolean, borderWidth?: number) =>
  borderWidth ??
  (highlighted ? uiBorders.highlightWidth : uiBorders.defaultWidth);

const resolveBorderColor = (highlighted: boolean, borderColor?: string) =>
  borderColor ?? (highlighted ? uiColors.highlightBorder : undefined);

const resolveBadgeColor = (highlighted: boolean) =>
  highlighted ? "brand" : "cyan";

export function PricingCard({
  name,
  price,
  description,
  features,
  cta,
  ctaProps,
  ctaDisabled,
  highlighted = false,
  badge,
  note,
  billingLabel,
  tone,
  borderColor,
  borderWidth,
  testId,
}: PricingCardProps) {
  const badgeLabel = resolveBadgeLabel(highlighted, badge);
  const buttonVariant = resolveButtonVariant(highlighted, ctaProps);
  const buttonGradient = resolveButtonGradient(highlighted, ctaProps);
  const buttonDisabled = resolveButtonDisabled(ctaProps, ctaDisabled);
  const computedTone = resolveTone(highlighted, tone);
  const computedBorderWidth = resolveBorderWidth(highlighted, borderWidth);
  const computedBorderColor = resolveBorderColor(highlighted, borderColor);
  const badgeColor = resolveBadgeColor(highlighted);
  return (
    <Surface
      p="xl"
      tone={computedTone}
      data-testid={testId}
      style={{
        borderWidth: computedBorderWidth,
        borderColor: computedBorderColor,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <Stack gap="md" style={{ flex: 1 }}>
        <Stack gap={6}>
          <Badge
            variant={highlighted ? "filled" : "light"}
            color={badgeColor}
            w="fit-content"
            style={{ visibility: badgeLabel ? "visible" : "hidden" }}
            aria-hidden={!badgeLabel}
          >
            {badgeLabel ?? "placeholder"}
          </Badge>
          <Title order={3}>{name}</Title>
          <Text c="dimmed">{description}</Text>
        </Stack>
        <Stack gap={4}>
          <Text fw={700} size="xl">
            {price}
          </Text>
          <Text size="sm" c="dimmed">
            {billingLabel ?? "Billed monthly"}
          </Text>
        </Stack>
        <List
          spacing="xs"
          size="sm"
          styles={{ item: { display: "block" } }}
          icon={
            <ThemeIcon color={highlighted ? "brand" : "gray"} size={20}>
              <IconCheck size={12} />
            </ThemeIcon>
          }
        >
          {features.map((feature) => (
            <List.Item key={feature}>{feature}</List.Item>
          ))}
        </List>
        <Box mt="auto">
          {cta ? (
            <Button
              variant={buttonVariant}
              gradient={
                buttonVariant === "gradient" ? buttonGradient : undefined
              }
              fullWidth
              {...ctaProps}
              disabled={buttonDisabled}
            >
              {cta}
            </Button>
          ) : null}
          {note ? (
            <Text size="xs" c="dimmed" mt="xs">
              {note}
            </Text>
          ) : null}
        </Box>
      </Stack>
    </Surface>
  );
}

export default PricingCard;
