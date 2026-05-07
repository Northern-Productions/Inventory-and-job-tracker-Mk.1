-- Keep the private app schema closed to direct authenticated user access.
-- User-facing database access continues through public SECURITY DEFINER RPCs
-- and Edge handlers; service_role keeps app schema access for Edge REST paths.

revoke usage on schema app from authenticated;
