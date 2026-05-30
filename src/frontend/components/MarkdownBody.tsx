import { Text, Typography } from "@mantine/core";
import type { ComponentProps, MouseEvent } from "react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getDiscordOpenUrl } from "../utils/discordLinks";
import { uiColors } from "../uiTokens";

export type MarkdownLinkHandler = {
  resolveHref?: (href: string) => string;
  onLinkClick?: (options: {
    href: string;
    event: MouseEvent<HTMLAnchorElement>;
  }) => void;
  openInNewTab?: boolean | ((href: string) => boolean);
};

type MarkdownBodyProps = {
  content: string;
  compact?: boolean;
  dimmed?: boolean;
  linkHandler?: MarkdownLinkHandler;
};

const resolveOpenInNewTab = (
  href: string | undefined,
  handler?: MarkdownLinkHandler,
) => {
  if (handler?.openInNewTab === undefined) return true;
  if (typeof handler.openInNewTab === "function") {
    return href ? handler.openInNewTab(href) : true;
  }
  return handler.openInNewTab;
};

const resolveNormalizedHref = (href?: string) =>
  href ? getDiscordOpenUrl(href) : undefined;

const resolveRenderedHref = (
  href: string | undefined,
  handler?: MarkdownLinkHandler,
) => (href && handler?.resolveHref ? handler.resolveHref(href) : href);

const resolveLinkTarget = (
  href: string | undefined,
  handler?: MarkdownLinkHandler,
) => {
  const openInNewTab = resolveOpenInNewTab(href, handler);
  return {
    target: openInNewTab ? "_blank" : undefined,
    rel: openInNewTab ? "noreferrer" : undefined,
  };
};

const handleLinkClick = (
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  handler?: MarkdownLinkHandler,
) => {
  if (!href) return;
  handler?.onLinkClick?.({ href, event });
};

const renderMarkdownLink = (
  props: ComponentProps<"a">,
  handler?: MarkdownLinkHandler,
) => {
  const { href, ...rest } = props;
  const normalizedHref = resolveNormalizedHref(href);
  const resolvedHref = resolveRenderedHref(normalizedHref, handler);
  const { target, rel } = resolveLinkTarget(resolvedHref, handler);
  return (
    <a
      {...rest}
      href={resolvedHref}
      target={target}
      rel={rel}
      style={{
        color: uiColors.linkAccent,
      }}
      onClick={(event) => handleLinkClick(event, resolvedHref, handler)}
    />
  );
};

const buildMarkdownComponents = (options: {
  compact: boolean;
  linkHandler?: MarkdownLinkHandler;
}) => ({
  a: (props: ComponentProps<"a">) =>
    renderMarkdownLink(props, options.linkHandler),
  ...(options.compact
    ? {
        p: (props: ComponentProps<"p">) => (
          <p {...props} style={{ margin: 0 }} />
        ),
      }
    : {}),
});

export default function MarkdownBody({
  content,
  compact = false,
  dimmed = false,
  linkHandler,
}: MarkdownBodyProps) {
  const components = useMemo(
    () => buildMarkdownComponents({ compact, linkHandler }),
    [compact, linkHandler],
  );

  return (
    <Text size="sm" c={dimmed ? "dimmed" : undefined} component="div">
      <Typography>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </Typography>
    </Text>
  );
}

export type { MarkdownBodyProps };
