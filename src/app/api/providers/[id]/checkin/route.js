import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import {
  executeCheckinForConnection,
  executeCheckinStatusForConnection,
} from "@/shared/services/checkinRunner";

export const dynamic = "force-dynamic";

/**
 * GET /api/providers/[id]/checkin
 * Query check-in activity status (e.g. today_checked_in, streak_days, total_credits)
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const result = await executeCheckinStatusForConnection(connection);
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          http: result.http,
          biz_code: result.biz_code,
          error: result.error || "Failed to fetch check-in status",
          raw: result.raw,
        },
        { status: result.http && result.http >= 400 && result.http < 500 ? result.http : 502 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Check-in status API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/providers/[id]/checkin
 * Execute daily check-in
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const result = await executeCheckinForConnection(connection);
    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          http: result.http,
          biz_code: result.biz_code,
          error: result.error || "Check-in failed",
          raw: result.raw,
        },
        { status: result.http && result.http >= 400 && result.http < 500 ? result.http : 400 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Check-in API] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
