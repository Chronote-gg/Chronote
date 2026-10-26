import { Radio, Stack, Text } from "@mantine/core";
import type { IntroOfferChoice } from "../../types/pricing";

export default function IntroPromotionChoice({
  choice,
  onChange,
  disabled,
}: {
  choice: IntroOfferChoice;
  onChange: (choice: IntroOfferChoice) => void;
  disabled: boolean;
}) {
  return (
    <Stack gap="xs" data-testid="intro-promotion-choice">
      <Text size="sm">
        The introductory offer and your code cannot be combined. Choose which to
        use for Basic.
      </Text>
      <Radio.Group
        value={choice}
        onChange={(value) =>
          onChange(value === "promotion" ? "promotion" : "automatic")
        }
        aria-label="Basic discount"
      >
        <Stack gap="xs">
          <Radio
            value="automatic"
            label="Use the introductory offer"
            disabled={disabled}
          />
          <Radio
            value="promotion"
            label="Use my promotion code instead"
            disabled={disabled}
          />
        </Stack>
      </Radio.Group>
      <Text size="xs" c="dimmed">
        Your code stays saved. Its eligibility and price will be confirmed at
        checkout.
      </Text>
    </Stack>
  );
}
