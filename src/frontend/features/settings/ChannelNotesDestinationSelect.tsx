import { Button } from "@mantine/core";
import FormSelect from "../../components/FormSelect";
import {
  formatChannelLabel,
  type ChannelOption,
} from "../../utils/settingsChannels";

type Props = {
  value: string | null;
  onChange: (value: string | null) => void;
  defaultChannelId: string | null;
  defaultLabel?: string;
  channels: ChannelOption[];
  loading: boolean;
};

export function ChannelNotesDestinationSelect({
  value,
  onChange,
  defaultChannelId,
  defaultLabel,
  channels,
  loading,
}: Props) {
  const unavailable =
    value && !channels.some((channel) => channel.value === value);
  return (
    <>
      <FormSelect
        label="Notes channel"
        description={
          value !== null
            ? "Voice channel override"
            : defaultChannelId
              ? "Server default"
              : "No server default. Manually started meetings use the channel where the command was run."
        }
        placeholder={loading ? "Loading..." : "Select channel"}
        data={[
          {
            value: "__default",
            label: defaultChannelId
              ? `Use server default (${defaultLabel ?? "Unavailable notes channel"})`
              : "Use server default",
          },
          ...(unavailable
            ? [{ value, label: "Unavailable notes channel", disabled: true }]
            : []),
          ...channels.map((channel) => ({
            value: channel.value,
            label: formatChannelLabel(channel),
            disabled: !channel.botAccess,
          })),
        ]}
        value={value ?? "__default"}
        onChange={(next) => onChange(next === "__default" ? null : next)}
      />
      <Button
        variant="subtle"
        onClick={() => onChange(null)}
        disabled={value === null}
      >
        Reset to server default
      </Button>
    </>
  );
}
