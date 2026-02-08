import type { ReactElement } from "react";

type ReactQuillNewProps = {
  value?: unknown;
  onChange?: (
    value: string,
    delta: unknown,
    source: string,
    editor: { getContents: () => unknown },
  ) => void;
  theme?: string;
  modules?: unknown;
  style?: unknown;
};

export default function ReactQuillNew(
  _props: ReactQuillNewProps,
): ReactElement {
  void _props;
  return (
    <div data-testid="react-quill-mock">
      <button
        type="button"
        data-testid="react-quill-mock-change"
        onClick={() =>
          _props.onChange?.("", {}, "user", {
            getContents: () => ({ ops: [{ insert: "Changed\n" }] }),
          })
        }
      >
        change
      </button>
    </div>
  );
}
