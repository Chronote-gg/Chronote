import type { ReactElement } from "react";

type ReactQuillNewProps = {
  value?: unknown;
  onChange?: (...args: unknown[]) => void;
  theme?: string;
  modules?: unknown;
  style?: unknown;
};

export default function ReactQuillNew(
  _props: ReactQuillNewProps,
): ReactElement {
  void _props;
  return <div data-testid="react-quill-mock" />;
}
