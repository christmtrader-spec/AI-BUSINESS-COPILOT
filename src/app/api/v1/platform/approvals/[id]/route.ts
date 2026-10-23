/**
 * GET /api/v1/platform/approvals/[id] — approval request detail
 * (platform:approvals:read). Prompt 65 §10.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { approvalDto, getApprovalRequest } from "@/lib/platform/approvals";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  if (!ctx.permissions.includes("platform:approvals:read")) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
      permission: "platform:approvals:read",
    });
  }
  const { id } = await params;
  const row = await getApprovalRequest(id);
  if (!row) {
    // No-existence-oracle law (§126).
    throw platformError(404, "PLATFORM_NOT_FOUND", "Approval request not found.");
  }
  return platformOk({ approval: approvalDto(row) });
});
