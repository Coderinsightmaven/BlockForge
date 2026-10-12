import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Me } from "@blockforge/contracts";
import { meQuery } from "./queries";

/**
 * The signed-in session inside the authenticated area. The `_app` guard resolved it before any
 * child rendered, so it is always defined; the query keeps it fresh (permissions, MFA state).
 */
export function useMe(): Me {
  const { me } = useRouteContext({ from: "/_app" });
  const { data } = useQuery({ ...meQuery, initialData: me });
  return data;
}
