import { Router } from "express";
import { db } from "../db";
import { eq, desc } from "drizzle-orm";
import { alerts, users, forms } from "../db/schema";
import { sendMail, escapeHtml, isValidEmail } from "../services/email";
import { logger } from "../logger";

const router = Router();

// Valid alert types
const VALID_ALERT_TYPES = [
  "Missed Task",
  "Critical Failure",
  "SLA Warning",
  "System",
] as const;

// GET /api/alerts — fetch all alerts (latest first, limit 50)
router.get("/", async (_req, res) => {
  try {
    const allAlerts = await db
      .select()
      .from(alerts)
      .orderBy(desc(alerts.timestamp))
      .limit(50);
    res.json(allAlerts);
  } catch (error) {
    logger.error("Error fetching alerts:", error);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

// POST /api/alerts — create a new alert
router.post("/", async (req, res) => {
  try {
    const { type, message, staffId, formId } = req.body;

    // Input validation
    if (!type || !message) {
      return res.status(400).json({ error: "type and message are required" });
    }
    if (!VALID_ALERT_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Invalid alert type. Must be one of: ${VALID_ALERT_TYPES.join(", ")}`,
      });
    }
    if (typeof message !== "string" || message.length > 1000) {
      return res
        .status(400)
        .json({ error: "Message must be a string with max 1000 characters" });
    }

    const [newAlert] = await db
      .insert(alerts)
      .values({
        type,
        message,
        staffId: staffId || null,
        formId: formId || null,
      })
      .returning();

    // Fire email notification to staff for Missed Tasks (non-blocking, with proper error handling)
    if (type === "Missed Task" && staffId) {
      // Use .then().catch() pattern to avoid unhandled promise rejection
      (async () => {
        const staffRes = await db
          .select()
          .from(users)
          .where(eq(users.id, staffId))
          .limit(1);
        const staff = staffRes[0];
        let formTitle = "Unknown Form";
        if (formId) {
          const formRes = await db
            .select()
            .from(forms)
            .where(eq(forms.id, formId))
            .limit(1);
          if (formRes[0]) formTitle = formRes[0].title;
        }

        if (staff && staff.email && isValidEmail(staff.email)) {
          await sendMail({
            to: staff.email,
            subject: `🔔 แจ้งเตือน: กรุณาทำรายการ ${escapeHtml(formTitle)}`,
            html: `
              <div style="font-family: sans-serif; color: #333;">
                <h2 style="color: #f59e0b;">🔔 แจ้งเตือนคิวงานคงค้าง</h2>
                <p>เรียน คุณ ${escapeHtml(staff.name)}</p>
                <p>ระบบตรวจสอบพบว่า <strong>คุณยังไม่ได้ดำเนินการตรวจสอบ</strong> รายการเข้าเวรดังต่อไปนี้:</p>
                <div style="background-color: #fffbeb; padding: 15px; border-left: 4px solid #f59e0b; margin: 15px 0;">
                  <p><strong>รายการ:</strong> ${escapeHtml(formTitle)}</p>
                  <p style="color: #666; font-size: 0.9em;">${escapeHtml(message)}</p>
                </div>
                <p>กรุณาเข้าสู่ระบบเพื่อทำรายการให้เรียบร้อยก่อนหมดเวลา</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <small style="color: #999;">อีเมลฉบับนี้ถูกส่งอัตโนมัติจาก Imaging Compliance System</small>
              </div>
            `,
          });
          logger.info(
            `[Alert Email] ✅ Missed task email sent to ${staff.email}`,
          );
        } else if (staff) {
          logger.warn(
            `[Alert Email] ⚠️ Skipping email for ${staff.name} — invalid email: "${staff.email}"`,
          );
        }
      })().catch((e) => {
        logger.error("[Alert Email] ❌ Failed to send missed task email:", e);
      });
    }
    res.status(201).json(newAlert);
  } catch (error) {
    logger.error("Error creating alert:", error);
    res.status(500).json({ error: "Failed to create alert" });
  }
});

// PATCH /api/alerts/:id/read — mark alert as read
router.patch("/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    const [updated] = await db
      .update(alerts)
      .set({ isRead: true })
      .where(eq(alerts.id, id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Alert not found" });
    res.json(updated);
  } catch (error) {
    logger.error("Error updating alert:", error);
    res.status(500).json({ error: "Failed to update alert" });
  }
});

export default router;
