import { Router } from "express";
import { db } from "../db";
import {
  submissions,
  schedules,
  users,
  forms,
  config,
  alerts,
} from "../db/schema";
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { sendMail, escapeHtml, isValidEmail } from "../services/email";
import { getSubmissionFailures } from "../../src/utils/formUtils";
import { QuestionBlock } from "../../src/types";
import { logger } from "../logger";

const router = Router();

// GET /api/submissions — fetch paginated submissions
router.get("/", async (req, res) => {
  try {
    const { month, year, date } = req.query;
    let whereClause = undefined;

    if (date) {
      const startOfDay = new Date(`${date}T00:00:00+07:00`).toISOString();
      const endOfDay = new Date(`${date}T23:59:59.999+07:00`).toISOString();
      whereClause = and(
        gte(submissions.submittedAt, startOfDay),
        lte(submissions.submittedAt, endOfDay),
      );
    } else if (month && year) {
      // Filter by specific month
      const mStr = String(month).padStart(2, "0");
      const startOfMonth = new Date(
        `${year}-${mStr}-01T00:00:00+07:00`,
      ).toISOString();
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      const endOfMonth = new Date(
        `${year}-${mStr}-${String(lastDay).padStart(2, "0")}T23:59:59.999+07:00`,
      ).toISOString();
      whereClause = and(
        gte(submissions.submittedAt, startOfMonth),
        lte(submissions.submittedAt, endOfMonth),
      );
    } else if (year) {
      // Filter by entire year
      const startOfYear = new Date(
        `${year}-01-01T00:00:00+07:00`,
      ).toISOString();
      const endOfYear = new Date(
        `${year}-12-31T23:59:59.999+07:00`,
      ).toISOString();
      whereClause = and(
        gte(submissions.submittedAt, startOfYear),
        lte(submissions.submittedAt, endOfYear),
      );
    }

    const page = parseInt(req.query.page as string) || 1;
    // If filtering by date, fetch a large limit by default unless explicitly specified
    const limit =
      parseInt(req.query.limit as string) || (whereClause ? 10000 : 50);
    const offset = (page - 1) * limit;

    const allSubmissions = await db
      .select()
      .from(submissions)
      .where(whereClause)
      .orderBy(desc(submissions.submittedAt))
      .limit(limit)
      .offset(offset);

    const totalCount = whereClause
      ? await db.$count(submissions, whereClause)
      : await db.$count(submissions);

    const mapped = allSubmissions.map((s) => ({
      id: s.id,
      scheduleId: s.scheduleId,
      staffId: s.staffId,
      formId: s.formId,
      submittedAt: s.submittedAt,
      data: s.data as Record<string, unknown>,
      photos: s.photos as string[],
    }));

    const displayedPage = page;
    res.json({
      data: mapped,
      total: totalCount,
      page: displayedPage,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    logger.error("Error fetching submissions:", error);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
});

// GET /api/submissions/schedule/:scheduleId — fetch by schedule ID
router.get("/schedule/:scheduleId", async (req, res) => {
  try {
    const { scheduleId } = req.params;
    const existing = await db
      .select()
      .from(submissions)
      .where(eq(submissions.scheduleId, scheduleId))
      .limit(1);
    if (existing.length === 0)
      return res.status(404).json({ error: "Not found" });

    const s = existing[0];
    res.json({
      id: s.id,
      scheduleId: s.scheduleId,
      staffId: s.staffId,
      formId: s.formId,
      submittedAt: s.submittedAt,
      data: s.data as Record<string, unknown>,
      photos: s.photos as string[],
    });
  } catch (error) {
    logger.error("Error fetching submission by schedule ID:", error);
    res.status(500).json({ error: "Failed to fetch submission" });
  }
});

// POST /api/submissions — create submission + mark schedule as completed
router.post("/", async (req, res) => {
  try {
    const { scheduleId, staffId, formId, data, photos } = req.body;

    const reqUser = (req as any).user;
    if (reqUser && reqUser.id !== staffId && reqUser.role !== "ADMIN") {
      return res
        .status(403)
        .json({ error: "Unauthorized to submit for this user" });
    }

    const isAdhoc = scheduleId && String(scheduleId).startsWith("manual-");
    const dbScheduleId = isAdhoc ? null : scheduleId || null;

    let newSubmission: Record<string, unknown> | undefined;
    let isUpdate = false;

    // neon-http does not support transactions, executing queries sequentially
    if (dbScheduleId) {
      const existing = await db
        .select()
        .from(submissions)
        .where(eq(submissions.scheduleId, dbScheduleId))
        .limit(1);
      if (existing.length > 0) {
        isUpdate = true;
        const [updated] = await db
          .update(submissions)
          .set({
            data,
            photos: photos || [],
            submittedAt: new Date().toISOString(),
          })
          .where(eq(submissions.id, existing[0].id))
          .returning();
        newSubmission = updated;
      }
    }

    if (!newSubmission) {
      const [inserted] = await db
        .insert(submissions)
        .values({
          scheduleId: dbScheduleId,
          staffId,
          formId,
          data,
          photos: photos || [],
        })
        .returning();
      newSubmission = inserted;
    }

    // Mark the related schedule as Completed if scheduleId exists and is not a manual/ad-hoc one
    if (dbScheduleId) {
      await db
        .update(schedules)
        .set({ status: "Completed" })
        .where(eq(schedules.id, dbScheduleId))
        .catch((err) => {
          logger.error("Failed to update schedule status:", err);
        });
    }

    // --- Real-time Email Notification for Failures ---
    try {
      logger.info(
        `[FailAlert] Processing submission for form=${formId}, staff=${staffId}, isUpdate=${isUpdate}`,
      );

      const [form] = await db
        .select()
        .from(forms)
        .where(eq(forms.id, formId))
        .limit(1);
      const [staff] = await db
        .select()
        .from(users)
        .where(eq(users.id, staffId))
        .limit(1);

      if (!form) {
        logger.warn(`[FailAlert] Form not found: ${formId}`);
      }
      if (!staff) {
        logger.warn(`[FailAlert] Staff not found: ${staffId}`);
      }

      if (form && staff) {
        const safeData =
          typeof data === "object" && data !== null
            ? (data as Record<string, unknown>)
            : {};

        // Log the submission data and form questions for debugging
        const formQuestions = (form.questions as any[]) || [];
        logger.info(
          `[FailAlert] Form "${form.title}" has ${formQuestions.length} questions`,
        );

        // Log each answer for diagnosis
        for (const q of formQuestions) {
          const answer = String(safeData[q.id] || "");
          if (answer) {
            logger.info(
              `[FailAlert] Q: "${q.label}" (${q.type}) => "${answer}" | alertOnFail=${q.alertOnFail}, failOptions=${JSON.stringify(q.failOptions)}, alertOnCustomInput=${q.alertOnCustomInput}`,
            );
          }
        }

        // Use the exact same logic as the UI to determine failures
        const failedItems = getSubmissionFailures(
          { data: safeData } as any,
          form as any,
        ) as string[];
        const hasFailures = failedItems.length > 0;

        logger.info(
          `[FailAlert] Failure detection result: hasFailures=${hasFailures}, failedItems=${JSON.stringify(failedItems)}`,
        );

        if (hasFailures) {
          if (isUpdate) {
            logger.info(
              `[FailAlert] This is an update — still sending alert for new failures`,
            );
          }

          // --- In-App Alert ---
          await db
            .insert(alerts)
            .values({
              type: "Critical Failure",
              message: `พบปัญหาจากการตรวจสอบ: ${form.title} โดย ${staff.name}`,
              staffId: staff.id,
              formId: form.id,
            })
            .catch((err) =>
              logger.error("[FailAlert] Error inserting in-app alert:", err),
            );
          logger.info(`[FailAlert] In-app alert inserted`);

          const emailHtml = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #fee2e2; border-radius: 12px; overflow: hidden;">
              <div style="background-color: #fef2f2; padding: 20px; border-bottom: 2px solid #fca5a5;">
                <h2 style="color: #dc2626; margin: 0;">⚠️ พบปัญหาจากการตรวจสอบเครื่องมือ</h2>
              </div>
              <div style="padding: 20px;">
                <p><strong>ผู้ตรวจสอบ:</strong> ${escapeHtml(staff.name)}</p>
                <p><strong>แบบฟอร์ม:</strong> ${escapeHtml(form.title)}</p>
                <p><strong>เวลาที่บันทึก:</strong> ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</p>
                
                <h3 style="color: #991b1b; margin-top: 20px;">รายการที่ขัดข้อง:</h3>
                <ul style="background-color: #fff5f5; padding: 15px 15px 15px 35px; border-radius: 8px; border: 1px solid #fecaca; color: #b91c1c;">
                  ${failedItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                </ul>
                
                <div style="margin-top: 30px; text-align: center;">
                  <a href="${(process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "")}/admin" style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">ดูรายละเอียดในระบบ</a>
                </div>
              </div>
            </div>
          `;

          const sysConfig = await db.select().from(config).limit(1);
          const settings = sysConfig[0]?.settings as
            | Record<string, unknown>
            | undefined;
          const configSupervisorEmail =
            (settings?.supervisorEmail as string | undefined) ||
            process.env.SUPERVISOR_EMAIL;

          const adminEmails = (
            await db.select().from(users).where(eq(users.role, "ADMIN"))
          )
            .map((u) => u.email)
            .filter(Boolean) as string[];
          const allRecipients = Array.from(
            new Set(
              [configSupervisorEmail, ...adminEmails].filter(
                Boolean,
              ) as string[],
            ),
          ).filter(isValidEmail);

          logger.info(
            `[FailAlert] Email recipients: ${JSON.stringify(allRecipients)} (supervisorEmail=${configSupervisorEmail}, adminEmails=${JSON.stringify(adminEmails)})`,
          );

          if (allRecipients.length > 0) {
            try {
              sendMail({
                to: allRecipients.join(","),
                subject: `⚠️ [ด่วน] พบปัญหาจากการตรวจสอบ: ${form.title.replace(/[\r\n]/g, "")} โดย ${staff.name.replace(/[\r\n]/g, "")}`,
                html: emailHtml,
              })
                .then(() => {
                  logger.info(
                    `[FailAlert] ✅ Email sent successfully for form ${formId}`,
                  );
                })
                .catch((err) => {
                  logger.error(
                    "[FailAlert] ❌ Error sending email in background:",
                    err,
                  );
                });
            } catch (dispatchErr) {
              logger.error(
                "[FailAlert] ❌ Error dispatching email:",
                dispatchErr,
              );
            }
          } else {
            logger.warn(
              `[FailAlert] ⚠️ No valid email recipients found — alert email NOT sent`,
            );
          }
        } else {
          logger.info(`[FailAlert] No failures detected — no alert needed`);
        }
      }
    } catch (err) {
      logger.error("[FailAlert] ❌ Error in failure alert processing:", err);
    }
    // ------------------------------------------------

    if (!newSubmission) {
      throw new Error("Failed to create or update submission");
    }

    res.status(201).json({
      ...newSubmission,
      data: newSubmission.data as Record<string, unknown>,
      photos: newSubmission.photos as string[],
    });
  } catch (error) {
    logger.error("Error creating submission:", error);
    res.status(500).json({ error: "Failed to create submission" });
  }
});

// DELETE /api/submissions/:id — delete a submission and reset schedule to Pending
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // neon-http does not support transactions, executing queries sequentially
    // Find the submission first to get the scheduleId
    const [existing] = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, id))
      .limit(1);
    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    // Delete the submission
    await db.delete(submissions).where(eq(submissions.id, id));

    // Reset the related schedule back to Pending (if it has a real scheduleId)
    if (existing.scheduleId) {
      await db
        .update(schedules)
        .set({ status: "Pending" })
        .where(eq(schedules.id, existing.scheduleId))
        .catch((err) => {
          logger.error("Failed to update schedule status:", err);
        });
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Submission not found" });
    }
    logger.error("Error deleting submission:", error);
    res.status(500).json({ error: "Failed to delete submission" });
  }
});

export default router;
