import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { expect, userEvent, within } from "storybook/test";
import { trpc } from "../../services/trpc";
import DictionaryTeachingModal from "./DictionaryTeachingModal";

const previewResult = {
  token: "11111111-1111-4111-8111-111111111111",
  expiresAtMs: Date.now() + 15 * 60 * 1_000,
  drafts: [
    {
      draftId: "22222222-2222-4222-8222-222222222222",
      preferredTerm: "Jon Smythe",
      observedForms: ["John Smith"],
      description: "Apollo project collaborator",
      ambiguity: null,
      evidence: [
        {
          source: "instruction" as const,
          quote: "his name is Jon Smythe",
        },
      ],
      action: "create" as const,
    },
    {
      draftId: "33333333-3333-4333-8333-333333333333",
      preferredTerm: "APOLLO",
      observedForms: ["Apollo"],
      description: "Internal deployment project",
      ambiguity: "Confirm whether the project name should be all caps.",
      evidence: [
        {
          source: "instruction" as const,
          quote: "Apollo",
        },
      ],
      action: "conflict" as const,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      draftId: `44444444-4444-4444-8444-44444444444${index}`,
      preferredTerm: `Example term ${index + 1}`,
      observedForms: [],
      description: "Additional server vocabulary for scroll-state coverage",
      ambiguity: null,
      evidence: [],
      action: "create" as const,
    })),
  ],
};

function TrpcStoryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/trpc",
          fetch: async () =>
            new Response(
              JSON.stringify([
                {
                  result: {
                    data: previewResult,
                  },
                },
              ]),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta: Meta<typeof DictionaryTeachingModal> = {
  title: "Settings/DictionaryTeachingModal",
  component: DictionaryTeachingModal,
  decorators: [
    (Story) => (
      <TrpcStoryProvider>
        <Story />
      </TrpcStoryProvider>
    ),
  ],
  args: {
    opened: true,
    serverId: "server-1",
    onClose: () => undefined,
    onSaved: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof DictionaryTeachingModal>;

export const Compose: Story = {};

export const Review: Story = {
  args: {
    initialInstruction:
      "It wrote John Smith, but his name is Jon Smythe. He works with us on Apollo.",
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Review terms" }),
    );
    await expect(await page.findByDisplayValue("Jon Smythe")).toBeVisible();
  },
};
