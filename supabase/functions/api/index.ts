import { handleApiRequest } from "../_shared/api-handler.ts";

Deno.serve((request: Request) => handleApiRequest(request, "api"));
