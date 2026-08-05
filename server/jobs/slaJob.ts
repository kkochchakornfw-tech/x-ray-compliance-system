import { db } from "../db";
import { schedules, forms, users, config, alerts } from "../db/schema";
import { eq, and, inArray, isNotNull, gte } from "drizzle-orm";
import { logger } from "../logger";
import { sendEmail, escapeHtml, isValidEmail } from "../services/email";
import {
  getShiftThaiName,
  parseShiftStartHour,
  parseShiftEndHour,
  getBangkokNow,
  getBangkokDateStr,
} from "../utils/shiftHelpers";

let isSlaJobRunning = false;

export const runSLAJob = async () => {
  if (isSlaJobRunning) {
    logger.warn(
      "[SLA Job] ⚠️ Skipped run because previous job is still running.",
    );
    return;
  }
  isSlaJobRunning = true;

  try {
    // Ensure we check SLA against Thailand Timezone (UTC+7)
    const now = getBangkokNow();

    const currentHour = now.getUTCHours();
    const currentDecimalHour = currentHour + now.getUTCMinutes() / 60;
    const todayStr = getBangkokDateStr(now);
    // Calculate a reasonable lower bound for date filtering (7 days ago)
    const pastBound = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const pastBoundStr = getBangkokDateStr(pastBound);

    logger.info(
      `[SLA Job] ⏰ Running at ${currentHour}:${String(now.getUTCMinutes()).padStart(2, "0")} BKK (${currentDecimalHour.toFixed(2)} decimal) | Date: ${todayStr}`,
    );

    // Fetch config first to get SLA hours and emails
    const sysConfig = await db.select().from(config).limit(1);
    const settings = sysConfig[0]?.settings as
      | Record<string, unknown>
      | undefined;
    const supervisorEmail =
      (settings?.supervisorEmail as string | undefined) ||
      process.env.SUPERVISOR_EMAIL;
    const slaHoursCfg =
      (settings?.slaHours as {
        Morning?: number;
        Afternoon?: number;
        Night?: number;
        NightBeforeMorning?: number;
      }) || {};
    const shiftsConfig = settings?.shifts as
      | {
          Morning?: string;
          Afternoon?: string;
          Night?: string;
          NightBeforeMorning?: string;
        }
      | undefined;

    const shiftsList = [
      {
        name: "Morning",
        start: parseShiftStartHour(shiftsConfig?.Morning, 8),
        endStr: shiftsConfig?.Morning,
        defaultEnd: 16,
        sla: slaHoursCfg.Morning ?? 1.5,
        end: 0,
        limit: 0,
      },
      {
        name: "Afternoon",
        start: parseShiftStartHour(shiftsConfig?.Afternoon, 16),
        endStr: shiftsConfig?.Afternoon,
        defaultEnd: 0,
        sla: slaHoursCfg.Afternoon ?? 1.5,
        end: 0,
        limit: 0,
      },
      {
        name: "Night",
        start: parseShiftStartHour(shiftsConfig?.Night, 0),
        endStr: shiftsConfig?.Night,
        defaultEnd: 8,
        sla: slaHoursCfg.Night ?? 1.5,
        end: 0,
        limit: 0,
      },
      {
        name: "NightBeforeMorning",
        start: parseShiftStartHour(shiftsConfig?.NightBeforeMorning, 4),
        endStr: shiftsConfig?.NightBeforeMorning,
        defaultEnd: 8,
        sla: slaHoursCfg.NightBeforeMorning ?? 1.5,
        end: 0,
        limit: 0,
      },
    ];

    for (const current of shiftsList) {
      // If a Night shift starts after midnight (e.g. 00:00),
      // it actually physically occurs on the next day relative to the "schedule date".
      if (
        (current.name === "Night" || current.name === "NightBeforeMorning") &&
        current.start < 12
      ) {
        current.start += 24;
      }

      let end = parseShiftEndHour(current.endStr, current.defaultEnd);
      const originalStart = current.start % 24;

      if (end <= originalStart) {
        end += 24; // wraps around midnight
      }
      if (current.start >= 24 && end < 24) {
        end += 24; // If start was pushed to next day, end must also be on or after next day
      }

      current.end = end;
      current.limit = current.start + current.sla;
    }

    const shiftsMap = new Map(shiftsList.map((s) => [s.name, s]));

    // ==========================================
    // 1. STAFF SLA REMINDER (During Shift)
    // ==========================================
    const staffPending = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, "Pending"),
          eq(schedules.slaAlertSent, false),
          isNotNull(schedules.formId),
          gte(schedules.date, pastBoundStr), // Only check recent schedules to avoid loading old data
        ),
      );

    const staffToAlert: typeof staffPending = [];
    for (const sched of staffPending) {
      const s = shiftsMap.get(sched.shift);
      if (!s) continue;

      const schedDate = new Date(`${sched.date}T00:00:00.000Z`);

      const deadlineTime = schedDate.getTime() + s.limit * 60 * 60 * 1000;
      const endTime = schedDate.getTime() + s.end * 60 * 60 * 1000;

      if (now.getTime() >= deadlineTime && now.getTime() < endTime) {
        staffToAlert.push(sched);
      }
    }

    if (staffToAlert.length > 0) {
      logger.info(
        `[SLA Job] 📋 Pending schedules for STAFF SLA: ${staffToAlert.length} found`,
      );
      const staffGroup: Record<
        string,
        {
          staffId: string;
          formIds: string[];
          scheduleIds: string[];
          shift: string;
        }
      > = {};
      for (const s of staffToAlert) {
        if (!staffGroup[s.staffId])
          staffGroup[s.staffId] = {
            staffId: s.staffId,
            formIds: [],
            scheduleIds: [],
            shift: s.shift,
          };
        if (s.formId) staffGroup[s.staffId].formIds.push(s.formId);
        staffGroup[s.staffId].scheduleIds.push(s.id);
      }

      const allStaffIds = [
        ...new Set(Object.values(staffGroup).map((g) => g.staffId)),
      ];
      const allFormIds = [
        ...new Set(Object.values(staffGroup).flatMap((g) => g.formIds)),
      ];
      const allStaff =
        allStaffIds.length > 0
          ? await db.select().from(users).where(inArray(users.id, allStaffIds))
          : [];
      const allFormsData =
        allFormIds.length > 0
          ? await db.select().from(forms).where(inArray(forms.id, allFormIds))
          : [];
      const staffMap = new Map(allStaff.map((s) => [s.id, s]));
      const formMap = new Map(allFormsData.map((f) => [f.id, f]));

      for (const group of Object.values(staffGroup)) {
        try {
          const staff = staffMap.get(group.staffId);
          if (!staff) continue;

          if (!staff.email || !isValidEmail(staff.email)) {
            logger.warn(
              `[SLA Job] ⚠️ Skipping staff ${staff.name} — invalid email: "${staff.email}"`,
            );
            continue;
          }

          const formTitles = group.formIds.map(
            (fId) => formMap.get(fId)?.title || "Unknown Form",
          );
          const shiftTh = getShiftThaiName(group.shift);

          const listHtml = formTitles
            .map((t) => `<li style="padding: 5px 0;">${escapeHtml(t)}</li>`)
            .join("");

          await sendEmail({
            to: staff.email,
            subject: `⚠️ แจ้งเตือน: คิวงานคงค้าง (เวร${shiftTh})`,
            html: `
              <div style="font-family: sans-serif; color: #333;">
                <h2 style="color: #d9534f;">⚠️ แจ้งเตือนรายการตรวจเช็คคงค้าง</h2>
                <p>เรียน คุณ ${escapeHtml(staff.name)}</p>
                <p>ระบบตรวจพบว่าคุณมีรายการตรวจเช็คที่ <strong>เลยกำหนดเวลา (SLA)</strong> ของเวร${shiftTh} จำนวน ${formTitles.length} รายการ ดังนี้:</p>
                <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #d9534f; margin: 15px 0;">
                  <ul style="margin: 0; padding-left: 20px;">
                    ${listHtml}
                  </ul>
                </div>
                <p>กรุณาเข้าสู่ระบบเพื่อดำเนินการตรวจสอบโดยด่วน ก่อนหมดเวลาเวร</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <small style="color: #999;">อีเมลฉบับนี้ถูกส่งอัตโนมัติจาก Imaging Compliance System (Staff Reminder)</small>
              </div>
            `,
          });

          await db
            .update(schedules)
            .set({ slaAlertSent: true })
            .where(inArray(schedules.id, group.scheduleIds));
          logger.info(
            `[SLA Job] ✅ Staff Reminder sent to ${staff.email} for schedules: ${group.scheduleIds.join(", ")}`,
          );
        } catch (staffErr) {
          logger.error(
            `[SLA Job] ❌ Error sending staff reminder for staffId=${group.staffId}:`,
            staffErr,
          );
          // Continue to next staff — don't let one failure stop all notifications
        }
      }
    }

    // ==========================================
    // 2. SUPERVISOR SHIFT-END SUMMARY
    // ==========================================
    // Send only to supervisor (and escalation) when the shift is completely OVER
    const supervisorPending = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.status, "Pending"),
          eq(schedules.supervisorAlertSent, false),
          isNotNull(schedules.formId),
          gte(schedules.date, pastBoundStr), // Only check recent schedules
        ),
      );

    const supToAlert: typeof supervisorPending = [];
    for (const sched of supervisorPending) {
      const s = shiftsMap.get(sched.shift);
      if (!s) continue;

      const schedDate = new Date(`${sched.date}T00:00:00.000Z`);

      const endTime = schedDate.getTime() + s.end * 60 * 60 * 1000;

      if (now.getTime() >= endTime) {
        supToAlert.push(sched);
      }
    }

    if (supToAlert.length > 0 && supervisorEmail) {
      logger.info(
        `[SLA Job] 📋 Shift-End Overdue tasks: ${supToAlert.length} found`,
      );

      const shiftGroups: Record<string, typeof supervisorPending> = {};

      for (const s of supToAlert) {
        if (!shiftGroups[s.shift]) shiftGroups[s.shift] = [];
        shiftGroups[s.shift].push(s);
      }

      const allShiftsToProcess = Object.keys(shiftGroups);

      for (const shiftName of allShiftsToProcess) {
        const scheds = shiftGroups[shiftName] || [];

        const allStaffIds = [...new Set(scheds.map((s) => s.staffId))];
        const allFormIds = [
          ...new Set(scheds.map((s) => s.formId).filter(Boolean) as string[]),
        ];

        const allStaff =
          allStaffIds.length > 0
            ? await db
                .select()
                .from(users)
                .where(inArray(users.id, allStaffIds))
            : [];
        const allFormsData =
          allFormIds.length > 0
            ? await db.select().from(forms).where(inArray(forms.id, allFormIds))
            : [];

        const staffMap = new Map(allStaff.map((s) => [s.id, s]));
        const formMap = new Map(allFormsData.map((f) => [f.id, f]));

        const shiftTh = getShiftThaiName(shiftName);

        // 1. Compile Missed Tasks
        let missedHtml = "";
        for (const sched of scheds) {
          const staff = staffMap.get(sched.staffId);
          const form = sched.formId ? formMap.get(sched.formId) : null;
          const staffName = staff ? escapeHtml(staff.name) : "Unknown Staff";
          const formTitle = form ? escapeHtml(form.title) : "Unknown Form";
          const schedDateTh = new Date(
            `${sched.date}T00:00:00.000Z`,
          ).toLocaleDateString("th-TH", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "Asia/Bangkok",
          });
          missedHtml += `<li style="padding: 5px 0;"><strong>${staffName}</strong> - ลืมทำ: ${formTitle} <span style="color: #888;">(วันที่ ${schedDateTh})</span></li>`;
        }

        if (missedHtml.length === 0) {
          continue;
        }

        const recipients = (supervisorEmail || "")
          .split(",")
          .map((e) => e.trim())
          .filter((e) => isValidEmail(e));
        if (recipients.length === 0) {
          logger.warn(
            `[SLA Job] ⚠️ No valid supervisor email for shift ${shiftTh} — skipping`,
          );
          continue;
        }
        const toList = recipients.join(",");

        let finalEmailHtml = `
            <div style="font-family: sans-serif; color: #333;">
              <h2 style="color: #00468B;">📊 รายงานสรุปการทำงาน (สิ้นสุดเวร${shiftTh})</h2>
              <p style="color: #888; margin-top: -8px;">วันที่ออกรายงาน: ${todayStr}</p>
              <p>เรียน หัวหน้างาน</p>
              <p>ระบบขอรายงานสรุปรายการตรวจเช็คของ <strong>เวร${shiftTh}</strong> ที่เพิ่งสิ้นสุดลง ดังนี้:</p>
        `;

        if (missedHtml.length > 0) {
          finalEmailHtml += `
              <div style="background-color: #fcf8e3; padding: 15px; border-left: 4px solid #f0ad4e; margin: 15px 0;">
                <h3 style="color: #f0ad4e; margin-top: 0;">⏳ รายการที่ไม่ได้ดำเนินการ (Missed Tasks)</h3>
                <ul style="margin: 0; padding-left: 20px;">
                  ${missedHtml}
                </ul>
              </div>
           `;
        }

        finalEmailHtml += `
              <p>โปรดพิจารณาติดตามหรือตรวจสอบเพิ่มเติมในระบบ</p>
              <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
              <small style="color: #999;">อีเมลฉบับนี้ถูกส่งอัตโนมัติจาก Imaging Compliance System (Shift-End Summary)</small>
            </div>
        `;

        await sendEmail({
          to: toList,
          subject: `📊 สรุปเวร${shiftTh}: พบความผิดปกติหรือลืมทำ`,
          html: finalEmailHtml,
        });

        const allSchedIdsToUpdate = [...scheds.map((s) => s.id)];
        if (allSchedIdsToUpdate.length > 0) {
          await db
            .update(schedules)
            .set({ supervisorAlertSent: true })
            .where(inArray(schedules.id, allSchedIdsToUpdate));

          // Insert into alerts table for in-app notification
          const newAlerts = scheds.map((sched) => ({
            type: "Missed Task" as const,
            message: `ลืมทำรายการ: ${sched.formId ? formMap.get(sched.formId)?.title || "Unknown Form" : "Unknown Form"} โดย ${staffMap.get(sched.staffId)?.name || "Unknown Staff"} (เวร${shiftTh})`,
            staffId: sched.staffId,
            formId: sched.formId,
          }));

          if (newAlerts.length > 0) {
            await db
              .insert(alerts)
              .values(newAlerts)
              .catch((err) =>
                logger.error(
                  "[SLA Job] Error inserting missed task alerts:",
                  err,
                ),
              );
          }
        }
        logger.info(
          `[SLA Job] ✅ Shift-End Summary sent to ${toList} for shift ${shiftTh}.`,
        );
      }
    }
  } catch (err: unknown) {
    logger.error("[SLA Job] ❌ Error in background job:", err);
  } finally {
    isSlaJobRunning = false;
  }
};
