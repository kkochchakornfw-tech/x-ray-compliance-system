import { db } from "../server/db";
import { users } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { sendMail } from "../server/services/email";

async function main() {
  try {
    const supervisorEmails = (
      await db.select().from(users).where(eq(users.role, "ADMIN"))
    )
      .map((u) => u.email)
      .filter(Boolean) as string[];
    console.log("Supervisor Emails:", supervisorEmails);

    if (supervisorEmails.length > 0) {
      console.log("Attempting to send email...");
      const info = await sendMail({
        to: supervisorEmails.join(","),
        subject: `⚠️ [ด่วน] พบปัญหาจากการตรวจสอบ (TEST SCRIPT)`,
        html: `<p>This is a test of the failure alert.</p>`,
      });
      console.log(`Sent real-time failure alert. Message ID:`, info.messageId);
    } else {
      console.log("No supervisor emails found.");
    }
  } catch (err) {
    console.error("Error sending real-time failure alert:", err);
  }
  process.exit(0);
}

main();
