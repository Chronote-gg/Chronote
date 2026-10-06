import { Navigate, useSearch } from "@tanstack/react-router";

export default function Upgrade() {
  const search = useSearch({ strict: false });
  return <Navigate to="/upgrade/select-server" search={search} replace />;
}
