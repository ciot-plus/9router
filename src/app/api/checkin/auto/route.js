import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  runAutoCheckinNow,
  getAutoCheckinStatus,
  startAutoCheckinScheduler,
  parseTargetHour,
} from "@/shared/services/autoCheckin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const autoCheckin = settings.autoCheckin || {
      enabled: true,
      time: "21:00:00",
      providers: {
        "codebuddy-cn": true,
        traework: true,
      },
      providerTimes: {},
    };

    const status = getAutoCheckinStatus();

    return NextResponse.json({
      success: true,
      config: autoCheckin,
      status,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { action, providerId, enabled, time } = body;

    const settings = await getSettings();
    const autoCheckin = settings.autoCheckin || {
      enabled: true,
      time: "21:00:00",
      providers: {
        "codebuddy-cn": true,
        traework: true,
      },
      providerTimes: {},
    };

    if (action === "trigger") {
      const result = await runAutoCheckinNow({ force: true, providerId });
      return NextResponse.json(result);
    }

    if (action === "setTime") {
      const targetHour = parseTargetHour(time, 21);
      const formattedTime = `${String(targetHour).padStart(2, "0")}:00:00`;

      const providerTimes = { ...(autoCheckin.providerTimes || {}) };
      if (providerId) {
        providerTimes[providerId] = formattedTime;
      }

      const updatedAutoCheckin = {
        ...autoCheckin,
        time: providerId ? (autoCheckin.time || formattedTime) : formattedTime,
        providerTimes,
      };

      await updateSettings({ autoCheckin: updatedAutoCheckin });
      startAutoCheckinScheduler();

      return NextResponse.json({
        success: true,
        config: updatedAutoCheckin,
        time: formattedTime,
        providerId: providerId || null,
      });
    }

    if (action === "toggle" && providerId) {
      const currentProviders = autoCheckin.providers || {};
      const nextProviders = {
        ...currentProviders,
        [providerId]: enabled !== undefined ? !!enabled : !currentProviders[providerId],
      };

      const updatedAutoCheckin = {
        ...autoCheckin,
        enabled: Object.values(nextProviders).some(Boolean),
        providers: nextProviders,
      };

      await updateSettings({ autoCheckin: updatedAutoCheckin });
      startAutoCheckinScheduler();

      return NextResponse.json({
        success: true,
        config: updatedAutoCheckin,
        enabled: nextProviders[providerId],
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
