/**
 * apps/web/src/lib/auth.ts
 *
 * Usage: React Query hooks for the current session.
 *
 *   const { data: user, isLoading } = useCurrentUser();   // null when signed out
 *   const logout = useLogout(); logout.mutate();
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type User } from "./api";

export const ME_KEY = ["me"] as const;

export function useCurrentUser() {
  return useQuery<User | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api.me()).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
    },
  });
}
