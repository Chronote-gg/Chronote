declare module "quill-delta-to-markdown" {
  const mod: {
    deltaToMarkdown: (ops: unknown[]) => string;
  };

  export default mod;
}
