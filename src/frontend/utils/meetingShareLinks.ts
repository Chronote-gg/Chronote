export const buildMeetingShareUrl = (options: {
  origin: string;
  serverId: string;
  shareId: string;
}) => {
  const url = new URL(
    `/share/meeting/${options.serverId}/${options.shareId}`,
    options.origin,
  );
  return url.toString();
};
